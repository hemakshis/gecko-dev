/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "CrashReporterHost.h"
#include "CrashReporterMetadataShmem.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/ipc/GeckoChildProcessHost.h"
#include "mozilla/recordreplay/ParentIPC.h"
#include "mozilla/Sprintf.h"
#include "mozilla/SyncRunnable.h"
#include "mozilla/Telemetry.h"
#include "nsExceptionHandler.h"
#include "nsIAsyncShutdown.h"
#include "nsICrashService.h"

namespace mozilla {
namespace ipc {

CrashReporterHost::CrashReporterHost(GeckoProcessType aProcessType,
                                     const Shmem& aShmem,
                                     ThreadId aThreadId)
 : mProcessType(aProcessType),
   mShmem(aShmem),
   mThreadId(aThreadId),
   mStartTime(::time(nullptr)),
   mFinalized(false)
{
}

bool
CrashReporterHost::GenerateCrashReport(base::ProcessId aPid)
{
  if (!TakeCrashedChildMinidump(aPid, nullptr)) {
    return false;
  }
  return FinalizeCrashReport();
}

RefPtr<nsIFile>
CrashReporterHost::TakeCrashedChildMinidump(base::ProcessId aPid, uint32_t* aOutSequence)
{
  MOZ_ASSERT(!HasMinidump());

  RefPtr<nsIFile> crashDump;
  if (!XRE_TakeMinidumpForChild(aPid, getter_AddRefs(crashDump), aOutSequence)) {
    return nullptr;
  }
  if (!AdoptMinidump(crashDump)) {
    return nullptr;
  }
  return crashDump.get();
}

bool
CrashReporterHost::AdoptMinidump(nsIFile* aFile)
{
  return CrashReporter::GetIDFromMinidump(aFile, mDumpID);
}

int32_t
CrashReporterHost::GetCrashType(const CrashReporter::AnnotationTable& aAnnotations)
{
  // RecordReplayHang is set in the middleman content process, so check aAnnotations.
  if (aAnnotations[CrashReporter::Annotation::RecordReplayHang].EqualsLiteral("1")) {
    return nsICrashService::CRASH_TYPE_HANG;
  }

  // PluginHang is set in the parent process, so check mExtraAnnotations.
  if (mExtraAnnotations[CrashReporter::Annotation::PluginHang].EqualsLiteral("1")) {
    return nsICrashService::CRASH_TYPE_HANG;
  }

  return nsICrashService::CRASH_TYPE_CRASH;
}

bool
CrashReporterHost::FinalizeCrashReport()
{
  MOZ_ASSERT(!mFinalized);
  MOZ_ASSERT(HasMinidump());

  CrashReporter::AnnotationTable annotations;

  nsAutoCString type;
  switch (mProcessType) {
    case GeckoProcessType_Content:
      type = NS_LITERAL_CSTRING("content");
      break;
    case GeckoProcessType_Plugin:
    case GeckoProcessType_GMPlugin:
      type = NS_LITERAL_CSTRING("plugin");
      break;
    case GeckoProcessType_GPU:
      type = NS_LITERAL_CSTRING("gpu");
      break;
    default:
      NS_ERROR("unknown process type");
      break;
  }
  annotations[CrashReporter::Annotation::ProcessType] = type;

  char startTime[32];
  SprintfLiteral(startTime, "%lld", static_cast<long long>(mStartTime));
  annotations[CrashReporter::Annotation::StartupTime] =
    nsDependentCString(startTime);

  // We might not have shmem (for example, when running crashreporter tests).
  if (mShmem.IsReadable()) {
    CrashReporterMetadataShmem::ReadAppNotes(mShmem, annotations);
  }
  CrashReporter::AppendExtraData(mDumpID, mExtraAnnotations);
  CrashReporter::AppendExtraData(mDumpID, annotations);

  int32_t crashType = GetCrashType(annotations);
  NotifyCrashService(mProcessType, crashType, mDumpID);

  mFinalized = true;
  return true;
}

namespace {
class GenerateMinidumpShutdownBlocker : public nsIAsyncShutdownBlocker {
public:
  GenerateMinidumpShutdownBlocker() = default;

  NS_IMETHOD BlockShutdown(nsIAsyncShutdownClient* aBarrierClient) override
  {
    return NS_OK;
  }

  NS_IMETHOD GetName(nsAString& aName) override
  {
    aName = NS_LITERAL_STRING("Crash Reporter: blocking on minidump"
                              "generation.");
    return NS_OK;
  }

  NS_IMETHOD GetState(nsIPropertyBag**) override
  {
    return NS_OK;
  }

  NS_DECL_THREADSAFE_ISUPPORTS

private:
  virtual ~GenerateMinidumpShutdownBlocker() = default;
};

NS_IMPL_ISUPPORTS(GenerateMinidumpShutdownBlocker, nsIAsyncShutdownBlocker)
}

static nsCOMPtr<nsIAsyncShutdownClient> GetShutdownBarrier()
{
  MOZ_ASSERT(NS_IsMainThread());

  nsCOMPtr<nsIAsyncShutdownService> svc = services::GetAsyncShutdown();
  nsCOMPtr<nsIAsyncShutdownClient> barrier;
  nsresult rv = svc->GetProfileBeforeChange(getter_AddRefs(barrier));

  if (NS_WARN_IF(NS_FAILED(rv))) {
    return nullptr;
  }

  return barrier.forget();
}

void
CrashReporterHost::GenerateMinidumpAndPair(GeckoChildProcessHost* aChildProcess,
                                           nsIFile* aMinidumpToPair,
                                           const nsACString& aPairName,
                                           std::function<void(bool)>&& aCallback,
                                           bool aAsync)
{
  base::ProcessHandle childHandle;
#ifdef XP_MACOSX
  childHandle = aChildProcess->GetChildTask();
#else
  childHandle = aChildProcess->GetChildProcessHandle();
#endif

  if (!mCreateMinidumpCallback.IsEmpty()) {
    aCallback(false);
    return;
  }
  mCreateMinidumpCallback.Init(std::move(aCallback), aAsync);

  if (!childHandle) {
    NS_WARNING("Failed to get child process handle.");
    mCreateMinidumpCallback.Invoke(false);
    return;
  }

  nsCOMPtr<nsIAsyncShutdownBlocker> shutdownBlocker;
  if (aAsync && NS_IsMainThread()) {
    nsCOMPtr<nsIAsyncShutdownClient> barrier = GetShutdownBarrier();
    if (!barrier) {
      mCreateMinidumpCallback.Invoke(false);
      return;
    }

    shutdownBlocker = new GenerateMinidumpShutdownBlocker();

    nsresult rv = barrier->AddBlocker(shutdownBlocker,
                                      NS_LITERAL_STRING(__FILE__), __LINE__,
                                      NS_LITERAL_STRING("Minidump generation"));
    Unused << NS_WARN_IF(NS_FAILED(rv));
  }

  std::function<void(bool)> callback =
    [this, shutdownBlocker](bool aResult) {
      if (aResult &&
          CrashReporter::GetIDFromMinidump(this->mTargetDump, this->mDumpID)) {
        this->mCreateMinidumpCallback.Invoke(true);
      } else {
        this->mCreateMinidumpCallback.Invoke(false);
       }

       if (shutdownBlocker) {
         nsCOMPtr<nsIAsyncShutdownClient> barrier = GetShutdownBarrier();
         if (barrier) {
           barrier->RemoveBlocker(shutdownBlocker);
         }
      }
    };

  CrashReporter::CreateMinidumpsAndPair(childHandle,
                                        mThreadId,
                                        aPairName,
                                        aMinidumpToPair,
                                        getter_AddRefs(mTargetDump),
                                        std::move(callback),
                                        aAsync);
}

/* static */ void
CrashReporterHost::NotifyCrashService(GeckoProcessType aProcessType,
                                      int32_t aCrashType,
                                      const nsString& aChildDumpID)
{
  if (!NS_IsMainThread()) {
    RefPtr<Runnable> runnable = NS_NewRunnableFunction(
      "ipc::CrashReporterHost::NotifyCrashService", [&]() -> void {
        CrashReporterHost::NotifyCrashService(aProcessType, aCrashType, aChildDumpID);
      });
    RefPtr<nsIThread> mainThread = do_GetMainThread();
    SyncRunnable::DispatchToThread(mainThread, runnable);
    return;
  }

  MOZ_ASSERT(!aChildDumpID.IsEmpty());

  nsCOMPtr<nsICrashService> crashService =
    do_GetService("@mozilla.org/crashservice;1");
  if (!crashService) {
    return;
  }

  int32_t processType;
  nsCString telemetryKey;

  switch (aProcessType) {
    case GeckoProcessType_Content:
      processType = nsICrashService::PROCESS_TYPE_CONTENT;
      telemetryKey.AssignLiteral("content");
      break;
    case GeckoProcessType_Plugin:
      processType = nsICrashService::PROCESS_TYPE_PLUGIN;
      if (aCrashType == nsICrashService::CRASH_TYPE_HANG) {
        telemetryKey.AssignLiteral("pluginhang");
      } else {
        telemetryKey.AssignLiteral("plugin");
      }
      break;
    case GeckoProcessType_GMPlugin:
      processType = nsICrashService::PROCESS_TYPE_GMPLUGIN;
      telemetryKey.AssignLiteral("gmplugin");
      break;
    case GeckoProcessType_GPU:
      processType = nsICrashService::PROCESS_TYPE_GPU;
      telemetryKey.AssignLiteral("gpu");
      break;
    default:
      NS_ERROR("unknown process type");
      return;
  }

  RefPtr<Promise> promise;
  crashService->AddCrash(processType, aCrashType, aChildDumpID, getter_AddRefs(promise));
  Telemetry::Accumulate(Telemetry::SUBPROCESS_CRASHES_WITH_DUMP, telemetryKey, 1);
}

void
CrashReporterHost::AddAnnotation(CrashReporter::Annotation aKey, bool aValue)
{
  mExtraAnnotations[aKey] = aValue ? NS_LITERAL_CSTRING("1")
                                   : NS_LITERAL_CSTRING("0");
}

void
CrashReporterHost::AddAnnotation(CrashReporter::Annotation aKey,
                                 int aValue)
{
  nsAutoCString valueString;
  valueString.AppendInt(aValue);
  mExtraAnnotations[aKey] = valueString;
}

void
CrashReporterHost::AddAnnotation(CrashReporter::Annotation aKey,
                                 unsigned int aValue)
{
  nsAutoCString valueString;
  valueString.AppendInt(aValue);
  mExtraAnnotations[aKey] = valueString;
}

void
CrashReporterHost::AddAnnotation(CrashReporter::Annotation aKey,
                                 const nsCString& aValue)
{
  mExtraAnnotations[aKey] = aValue;
}

} // namespace ipc
} // namespace mozilla
