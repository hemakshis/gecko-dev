/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set sw=2 ts=8 et tw=80 : */

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// HttpLog.h should generally be included first
#include "HttpLog.h"

#include "HttpBackgroundChannelChild.h"

#include "HttpChannelChild.h"
#include "mozilla/ipc/BackgroundChild.h"
#include "mozilla/ipc/PBackgroundChild.h"
#include "mozilla/IntegerPrintfMacros.h"
#include "mozilla/Unused.h"
#include "nsSocketTransportService2.h"

using mozilla::ipc::BackgroundChild;
using mozilla::ipc::IPCResult;

namespace mozilla {
namespace net {

// HttpBackgroundChannelChild
HttpBackgroundChannelChild::HttpBackgroundChannelChild() = default;

HttpBackgroundChannelChild::~HttpBackgroundChannelChild() = default;

nsresult
HttpBackgroundChannelChild::Init(HttpChannelChild* aChannelChild)
{
  LOG(("HttpBackgroundChannelChild::Init [this=%p httpChannel=%p channelId=%"
       PRIu64 "]\n", this, aChannelChild, aChannelChild->ChannelId()));
  MOZ_ASSERT(OnSocketThread());
  NS_ENSURE_ARG(aChannelChild);

  mChannelChild = aChannelChild;

  if (NS_WARN_IF(!CreateBackgroundChannel())) {
    mChannelChild = nullptr;
    return NS_ERROR_FAILURE;
  }

  return NS_OK;
}

void
HttpBackgroundChannelChild::OnChannelClosed()
{
  LOG(("HttpBackgroundChannelChild::OnChannelClosed [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());

  // HttpChannelChild is not going to handle any incoming message.
  mChannelChild = nullptr;

  // Remove pending IPC messages as well.
  mQueuedRunnables.Clear();
}

void
HttpBackgroundChannelChild::OnStartRequestReceived()
{
  LOG(("HttpBackgroundChannelChild::OnStartRequestReceived [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());
  MOZ_ASSERT(mChannelChild);
  MOZ_ASSERT(!mStartReceived); // Should only be called once.

  mStartReceived = true;

  nsTArray<nsCOMPtr<nsIRunnable>> runnables;
  runnables.SwapElements(mQueuedRunnables);

  for (const auto& event : runnables) {
    // Note: these runnables call Recv* methods on HttpBackgroundChannelChild
    // but not the Process* methods on HttpChannelChild.
    event->Run();
  }

  // Ensure no new message is enqueued.
  MOZ_ASSERT(mQueuedRunnables.IsEmpty());
}

bool
HttpBackgroundChannelChild::CreateBackgroundChannel()
{
  LOG(("HttpBackgroundChannelChild::CreateBackgroundChannel [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());
  MOZ_ASSERT(mChannelChild);

  PBackgroundChild* actorChild = BackgroundChild::GetOrCreateForCurrentThread();
  if (NS_WARN_IF(!actorChild)) {
    return false;
  }

  const uint64_t channelId = mChannelChild->ChannelId();
  if (!actorChild->SendPHttpBackgroundChannelConstructor(this, channelId)) {
    return false;
  }

  // hold extra reference for IPDL
  RefPtr<HttpBackgroundChannelChild> self = this;
  Unused << self.forget().take();

  mChannelChild->OnBackgroundChildReady(this);
  return true;
}

bool
HttpBackgroundChannelChild::IsWaitingOnStartRequest()
{
  MOZ_ASSERT(OnSocketThread());
  // Need to wait for OnStartRequest if it is sent by
  // parent process but not received by content process.
  return (mStartSent && !mStartReceived);
}

// PHttpBackgroundChannelChild
IPCResult
HttpBackgroundChannelChild::RecvOnStartRequestSent()
{
  LOG(("HttpBackgroundChannelChild::RecvOnStartRequestSent [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());
  MOZ_ASSERT(!mStartSent); // Should only receive this message once.

  mStartSent = true;
  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvOnTransportAndData(
                                               const nsresult& aChannelStatus,
                                               const nsresult& aTransportStatus,
                                               const uint64_t& aOffset,
                                               const uint32_t& aCount,
                                               const nsCString& aData)
{
  LOG(("HttpBackgroundChannelChild::RecvOnTransportAndData [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  if (IsWaitingOnStartRequest()) {
    LOG(("  > pending until OnStartRequest [offset=%" PRIu64 " count=%" PRIu32
         "]\n", aOffset, aCount));

    mQueuedRunnables.AppendElement(NewRunnableMethod<const nsresult,
                                                     const nsresult,
                                                     const uint64_t,
                                                     const uint32_t,
                                                     const nsCString>(
      "HttpBackgroundChannelChild::RecvOnTransportAndData",
      this,
      &HttpBackgroundChannelChild::RecvOnTransportAndData,
      aChannelStatus,
      aTransportStatus,
      aOffset,
      aCount,
      aData));

    return IPC_OK();
  }

  mChannelChild->ProcessOnTransportAndData(aChannelStatus,
                                           aTransportStatus,
                                           aOffset,
                                           aCount,
                                           aData);

  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvOnStopRequest(
                                    const nsresult& aChannelStatus,
                                    const ResourceTimingStruct& aTiming,
                                    const TimeStamp& aLastActiveTabOptHit,
                                    const nsHttpHeaderArray& aResponseTrailers)
{
  LOG(("HttpBackgroundChannelChild::RecvOnStopRequest [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());

  // It's enough to set this from (just before) OnStopRequest notification, since
  // we don't need this value sooner than a channel was done loading - everything
  // this timestamp affects takes place only after a channel's OnStopRequest.
  nsHttp::SetLastActiveTabLoadOptimizationHit(aLastActiveTabOptHit);

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  if (IsWaitingOnStartRequest()) {
    LOG(("  > pending until OnStartRequest [status=%" PRIx32 "]\n",
         static_cast<uint32_t>(aChannelStatus)));

    mQueuedRunnables.AppendElement(
      NewRunnableMethod<const nsresult,
                        const ResourceTimingStruct,
                        const TimeStamp,
                        const nsHttpHeaderArray>(
        "HttpBackgroundChannelChild::RecvOnStopRequest",
        this,
        &HttpBackgroundChannelChild::RecvOnStopRequest,
        aChannelStatus,
        aTiming,
        aLastActiveTabOptHit,
        aResponseTrailers));

    return IPC_OK();
  }

  mChannelChild->ProcessOnStopRequest(aChannelStatus, aTiming, aResponseTrailers);

  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvOnProgress(const int64_t& aProgress,
                                           const int64_t& aProgressMax)
{
  LOG(("HttpBackgroundChannelChild::RecvOnProgress [this=%p progress=%"
       PRId64 " max=%" PRId64 "]\n", this, aProgress, aProgressMax));
  MOZ_ASSERT(OnSocketThread());

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  if (IsWaitingOnStartRequest()) {
    LOG(("  > pending until OnStartRequest [progress=%" PRId64 " max=%"
         PRId64 "]\n", aProgress, aProgressMax));

    mQueuedRunnables.AppendElement(
      NewRunnableMethod<const int64_t, const int64_t>(
        "HttpBackgroundChannelChild::RecvOnProgress",
        this,
        &HttpBackgroundChannelChild::RecvOnProgress,
        aProgress,
        aProgressMax));

    return IPC_OK();
  }

  mChannelChild->ProcessOnProgress(aProgress, aProgressMax);

  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvOnStatus(const nsresult& aStatus)
{
  LOG(("HttpBackgroundChannelChild::RecvOnStatus [this=%p status=%"
       PRIx32 "]\n", this, static_cast<uint32_t>(aStatus)));
  MOZ_ASSERT(OnSocketThread());

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  if (IsWaitingOnStartRequest()) {
    LOG(("  > pending until OnStartRequest [status=%" PRIx32 "]\n",
         static_cast<uint32_t>(aStatus)));

    mQueuedRunnables.AppendElement(NewRunnableMethod<const nsresult>(
      "HttpBackgroundChannelChild::RecvOnStatus",
      this,
      &HttpBackgroundChannelChild::RecvOnStatus,
      aStatus));

    return IPC_OK();
  }

  mChannelChild->ProcessOnStatus(aStatus);

  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvFlushedForDiversion()
{
  LOG(("HttpBackgroundChannelChild::RecvFlushedForDiversion [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  if (IsWaitingOnStartRequest()) {
    LOG(("  > pending until OnStartRequest\n"));

    mQueuedRunnables.AppendElement(NewRunnableMethod(
      "HttpBackgroundChannelChild::RecvFlushedForDiversion",
      this,
      &HttpBackgroundChannelChild::RecvFlushedForDiversion));

    return IPC_OK();
  }

  mChannelChild->ProcessFlushedForDiversion();

  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvDivertMessages()
{
  LOG(("HttpBackgroundChannelChild::RecvDivertMessages [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  if (IsWaitingOnStartRequest()) {
    LOG(("  > pending until OnStartRequest\n"));

    mQueuedRunnables.AppendElement(
      NewRunnableMethod("HttpBackgroundChannelChild::RecvDivertMessages",
                        this,
                        &HttpBackgroundChannelChild::RecvDivertMessages));

    return IPC_OK();
  }

  mChannelChild->ProcessDivertMessages();

  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvNotifyTrackingProtectionDisabled()
{
  LOG(("HttpBackgroundChannelChild::RecvNotifyTrackingProtectionDisabled [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  // NotifyTrackingProtectionDisabled has no order dependency to OnStartRequest.
  // It this be handled as soon as possible
  mChannelChild->ProcessNotifyTrackingProtectionDisabled();

  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvNotifyTrackingResource(const bool& aIsThirdParty)
{
  LOG(("HttpBackgroundChannelChild::RecvNotifyTrackingResource thirdparty=%d "
       "[this=%p]\n", static_cast<int>(aIsThirdParty), this));
  MOZ_ASSERT(OnSocketThread());

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  // NotifyTrackingResource has no order dependency to OnStartRequest.
  // It this be handled as soon as possible
  mChannelChild->ProcessNotifyTrackingResource(aIsThirdParty);

  return IPC_OK();
}

IPCResult
HttpBackgroundChannelChild::RecvSetClassifierMatchedInfo(const ClassifierInfo& info)
{
  LOG(("HttpBackgroundChannelChild::RecvSetClassifierMatchedInfo [this=%p]\n", this));
  MOZ_ASSERT(OnSocketThread());

  if (NS_WARN_IF(!mChannelChild)) {
    return IPC_OK();
  }

  // SetClassifierMatchedInfo has no order dependency to OnStartRequest.
  // It this be handled as soon as possible
  mChannelChild->ProcessSetClassifierMatchedInfo(info.list(),
                                                 info.provider(),
                                                 info.fullhash());

  return IPC_OK();
}

void
HttpBackgroundChannelChild::ActorDestroy(ActorDestroyReason aWhy)
{
  LOG(("HttpBackgroundChannelChild::ActorDestroy[this=%p]\n", this));
  // This function might be called during shutdown phase, so OnSocketThread()
  // might return false even on STS thread. Use IsOnCurrentThreadInfallible()
  // to get correct information.
  MOZ_ASSERT(gSocketTransportService);
  MOZ_ASSERT(gSocketTransportService->IsOnCurrentThreadInfallible());

  // Ensure all IPC messages received before ActorDestroy can be
  // handled correctly. If there is any pending IPC message, destroyed
  // mChannelChild until those messages are flushed.
  // If background channel is not closed by normal IPDL actor deletion,
  // remove the HttpChannelChild reference and notify background channel
  // destroyed immediately.
  if (aWhy == Deletion && !mQueuedRunnables.IsEmpty()) {
    LOG(("  > pending until queued messages are flushed\n"));
    RefPtr<HttpBackgroundChannelChild> self = this;
    mQueuedRunnables.AppendElement(NS_NewRunnableFunction(
      "HttpBackgroundChannelChild::ActorDestroy", [self]() {
        MOZ_ASSERT(OnSocketThread());
        RefPtr<HttpChannelChild> channelChild = self->mChannelChild.forget();

        if (channelChild) {
          channelChild->OnBackgroundChildDestroyed(self);
        }
      }));
    return;
  }

  if (mChannelChild) {
    RefPtr<HttpChannelChild> channelChild = mChannelChild.forget();

    channelChild->OnBackgroundChildDestroyed(this);
  }
}

} // namespace net
} // namespace mozilla
