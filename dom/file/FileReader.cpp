/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FileReader.h"

#include "nsIEventTarget.h"
#include "nsIGlobalObject.h"
#include "nsITimer.h"

#include "mozilla/Base64.h"
#include "mozilla/CheckedInt.h"
#include "mozilla/dom/DOMException.h"
#include "mozilla/dom/DOMExceptionBinding.h"
#include "mozilla/dom/File.h"
#include "mozilla/dom/FileReaderBinding.h"
#include "mozilla/dom/ProgressEvent.h"
#include "mozilla/dom/WorkerCommon.h"
#include "mozilla/dom/WorkerRef.h"
#include "mozilla/dom/WorkerScope.h"
#include "mozilla/Encoding.h"
#include "nsAlgorithm.h"
#include "nsCycleCollectionParticipant.h"
#include "nsDOMJSUtils.h"
#include "nsError.h"
#include "nsNetUtil.h"
#include "xpcpublic.h"
#include "nsReadableUtils.h"

namespace mozilla {
namespace dom {

#define ABORT_STR "abort"
#define LOAD_STR "load"
#define LOADSTART_STR "loadstart"
#define LOADEND_STR "loadend"
#define ERROR_STR "error"
#define PROGRESS_STR "progress"

const uint64_t kUnknownSize = uint64_t(-1);

NS_IMPL_CYCLE_COLLECTION_CLASS(FileReader)

NS_IMPL_CYCLE_COLLECTION_TRAVERSE_BEGIN_INHERITED(FileReader,
                                                  DOMEventTargetHelper)
  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mBlob)
  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mProgressNotifier)
  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mError)
NS_IMPL_CYCLE_COLLECTION_TRAVERSE_END

NS_IMPL_CYCLE_COLLECTION_UNLINK_BEGIN_INHERITED(FileReader,
                                                DOMEventTargetHelper)
  tmp->Shutdown();
  NS_IMPL_CYCLE_COLLECTION_UNLINK(mBlob)
  NS_IMPL_CYCLE_COLLECTION_UNLINK(mProgressNotifier)
  NS_IMPL_CYCLE_COLLECTION_UNLINK(mError)
NS_IMPL_CYCLE_COLLECTION_UNLINK_END

NS_IMPL_CYCLE_COLLECTION_TRACE_BEGIN_INHERITED(FileReader,
                                               DOMEventTargetHelper)
  NS_IMPL_CYCLE_COLLECTION_TRACE_JS_MEMBER_CALLBACK(mResultArrayBuffer)
NS_IMPL_CYCLE_COLLECTION_TRACE_END

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(FileReader)
  NS_INTERFACE_MAP_ENTRY(nsITimerCallback)
  NS_INTERFACE_MAP_ENTRY(nsIInputStreamCallback)
  NS_INTERFACE_MAP_ENTRY(nsISupportsWeakReference)
  NS_INTERFACE_MAP_ENTRY(nsINamed)
NS_INTERFACE_MAP_END_INHERITING(DOMEventTargetHelper)

NS_IMPL_ADDREF_INHERITED(FileReader, DOMEventTargetHelper)
NS_IMPL_RELEASE_INHERITED(FileReader, DOMEventTargetHelper)

class MOZ_RAII FileReaderDecreaseBusyCounter
{
  RefPtr<FileReader> mFileReader;
public:
  explicit FileReaderDecreaseBusyCounter(FileReader* aFileReader)
    : mFileReader(aFileReader)
  {}

  ~FileReaderDecreaseBusyCounter()
  {
    mFileReader->DecreaseBusyCounter();
  }
};

void
FileReader::RootResultArrayBuffer()
{
  mozilla::HoldJSObjects(this);
}

//FileReader constructors/initializers

FileReader::FileReader(nsIGlobalObject* aGlobal,
                       WeakWorkerRef* aWorkerRef)
  : DOMEventTargetHelper(aGlobal)
  , mFileData(nullptr)
  , mDataLen(0)
  , mDataFormat(FILE_AS_BINARY)
  , mResultArrayBuffer(nullptr)
  , mProgressEventWasDelayed(false)
  , mTimerIsActive(false)
  , mReadyState(EMPTY)
  , mTotal(0)
  , mTransferred(0)
  , mBusyCount(0)
  , mWeakWorkerRef(aWorkerRef)
{
  MOZ_ASSERT(aGlobal);
  MOZ_ASSERT_IF(NS_IsMainThread(), !mWeakWorkerRef);

  if (NS_IsMainThread()) {
    mTarget = aGlobal->EventTargetFor(TaskCategory::Other);
  } else {
    mTarget = GetCurrentThreadSerialEventTarget();
  }

  SetDOMStringToNull(mResult);
}

FileReader::~FileReader()
{
  Shutdown();
  DropJSObjects(this);
}

/* static */ already_AddRefed<FileReader>
FileReader::Constructor(const GlobalObject& aGlobal, ErrorResult& aRv)
{
  nsCOMPtr<nsIGlobalObject> global = do_QueryInterface(aGlobal.GetAsSupports());
  RefPtr<WeakWorkerRef> workerRef;

  if (!NS_IsMainThread()) {
    JSContext* cx = aGlobal.Context();
    WorkerPrivate* workerPrivate = GetWorkerPrivateFromContext(cx);

    workerRef = WeakWorkerRef::Create(workerPrivate);
  }

  RefPtr<FileReader> fileReader = new FileReader(global, workerRef);

  return fileReader.forget();
}

// nsIInterfaceRequestor

NS_IMETHODIMP
FileReader::GetInterface(const nsIID & aIID, void **aResult)
{
  return QueryInterface(aIID, aResult);
}

void
FileReader::GetResult(JSContext* aCx,
                      JS::MutableHandle<JS::Value> aResult,
                      ErrorResult& aRv)
{
  JS::Rooted<JS::Value> result(aCx);

  if (mDataFormat == FILE_AS_ARRAYBUFFER) {
    if (mReadyState == DONE && mResultArrayBuffer) {
      result.setObject(*mResultArrayBuffer);
    } else {
      result.setNull();
    }

    if (!JS_WrapValue(aCx, &result)) {
      aRv.Throw(NS_ERROR_FAILURE);
      return;
    }

    aResult.set(result);
    return;
  }

  nsString tmpResult = mResult;
  if (!xpc::StringToJsval(aCx, tmpResult, aResult)) {
    aRv.Throw(NS_ERROR_FAILURE);
    return;
  }
}

void
FileReader::OnLoadEndArrayBuffer()
{
  AutoJSAPI jsapi;
  if (!jsapi.Init(GetParentObject())) {
    FreeDataAndDispatchError(NS_ERROR_FAILURE);
    return;
  }

  RootResultArrayBuffer();

  JSContext* cx = jsapi.cx();

  mResultArrayBuffer = JS_NewArrayBufferWithContents(cx, mDataLen, mFileData);
  if (mResultArrayBuffer) {
    mFileData = nullptr; // Transfer ownership
    FreeDataAndDispatchSuccess();
    return;
  }

  // Let's handle the error status.

  JS::Rooted<JS::Value> exceptionValue(cx);
  if (!JS_GetPendingException(cx, &exceptionValue) ||
      // This should not really happen, exception should always be an object.
      !exceptionValue.isObject()) {
    JS_ClearPendingException(jsapi.cx());
    FreeDataAndDispatchError(NS_ERROR_OUT_OF_MEMORY);
    return;
  }

  JS_ClearPendingException(jsapi.cx());

  JS::Rooted<JSObject*> exceptionObject(cx, &exceptionValue.toObject());
  JSErrorReport* er = JS_ErrorFromException(cx, exceptionObject);
  if (!er || er->message()) {
    FreeDataAndDispatchError(NS_ERROR_OUT_OF_MEMORY);
    return;
  }

  nsAutoString errorName;
  JSFlatString* name = js::GetErrorTypeName(cx, er->exnType);
  if (name) {
    AssignJSFlatString(errorName, name);
  }

  nsAutoCString errorMsg(er->message().c_str());
  nsAutoCString errorNameC = NS_LossyConvertUTF16toASCII(errorName);
  // XXX Code selected arbitrarily
  mError =
    new DOMException(NS_ERROR_DOM_INVALID_STATE_ERR, errorMsg,
                     errorNameC, DOMException_Binding::INVALID_STATE_ERR);

  FreeDataAndDispatchError();
}

nsresult
FileReader::DoAsyncWait()
{
  nsresult rv = IncreaseBusyCounter();
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }

  rv = mAsyncStream->AsyncWait(this,
                               /* aFlags*/ 0,
                               /* aRequestedCount */ 0,
                               mTarget);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    DecreaseBusyCounter();
    return rv;
  }

  return NS_OK;
}

namespace {

void
PopulateBufferForBinaryString(char16_t* aDest, const char* aSource,
                              uint32_t aCount)
{
  // Zero-extend each char to char16_t.
  ConvertLatin1toUTF16(MakeSpan(aSource, aCount), MakeSpan(aDest, aCount));
}

nsresult
ReadFuncBinaryString(nsIInputStream* aInputStream,
                     void* aClosure,
                     const char* aFromRawSegment,
                     uint32_t aToOffset,
                     uint32_t aCount,
                     uint32_t* aWriteCount)
{
  char16_t* dest = static_cast<char16_t*>(aClosure) + aToOffset;
  PopulateBufferForBinaryString(dest, aFromRawSegment, aCount);
  *aWriteCount = aCount;
  return NS_OK;
}

} // anonymous

nsresult
FileReader::DoReadData(uint64_t aCount)
{
  MOZ_ASSERT(mAsyncStream);

  uint32_t bytesRead = 0;

  if (mDataFormat == FILE_AS_BINARY) {
    //Continuously update our binary string as data comes in
    CheckedInt<uint64_t> size = mResult.Length();
    size += aCount;

    if (!size.isValid() ||
        size.value() > UINT32_MAX ||
        size.value() > mTotal) {
      return NS_ERROR_OUT_OF_MEMORY;
    }

    uint32_t oldLen = mResult.Length();
    MOZ_ASSERT(oldLen == mDataLen, "unexpected mResult length");

    char16_t* dest = nullptr;
    mResult.GetMutableData(&dest, size.value(), fallible);
    NS_ENSURE_TRUE(dest, NS_ERROR_OUT_OF_MEMORY);

    dest += oldLen;

    if (NS_InputStreamIsBuffered(mAsyncStream)) {
      nsresult rv = mAsyncStream->ReadSegments(ReadFuncBinaryString, dest,
                                               aCount, &bytesRead);
      NS_ENSURE_SUCCESS(rv, rv);
    } else {
      while (aCount > 0) {
        char tmpBuffer[4096];
        uint32_t minCount =
          XPCOM_MIN(aCount, static_cast<uint64_t>(sizeof(tmpBuffer)));
        uint32_t read;

        nsresult rv = mAsyncStream->Read(tmpBuffer, minCount, &read);
        if (rv == NS_BASE_STREAM_CLOSED) {
          rv = NS_OK;
        }

        NS_ENSURE_SUCCESS(rv, rv);

        if (read == 0) {
          // The stream finished too early.
          return NS_ERROR_OUT_OF_MEMORY;
        }

        PopulateBufferForBinaryString(dest, tmpBuffer, read);

        dest += read;
        aCount -= read;
        bytesRead += read;
      }
    }

    MOZ_ASSERT(size.value() == oldLen + bytesRead);
    mResult.Truncate(size.value());
  }
  else {
    CheckedInt<uint64_t> size = mDataLen;
    size += aCount;

    //Update memory buffer to reflect the contents of the file
    if (!size.isValid() ||
        // PR_Realloc doesn't support over 4GB memory size even if 64-bit OS
        // XXX: it's likely that this check is unnecessary and the comment is
        // wrong because we no longer use PR_Realloc outside of NSPR and NSS.
        size.value() > UINT32_MAX ||
        size.value() > mTotal) {
      return NS_ERROR_OUT_OF_MEMORY;
    }

    MOZ_DIAGNOSTIC_ASSERT(mFileData);
    MOZ_RELEASE_ASSERT((mDataLen + aCount) <= mTotal);

    nsresult rv = mAsyncStream->Read(mFileData + mDataLen, aCount, &bytesRead);
    if (NS_WARN_IF(NS_FAILED(rv))) {
      return rv;
    }
  }

  mDataLen += bytesRead;
  return NS_OK;
}

// Helper methods

void
FileReader::ReadFileContent(Blob& aBlob,
                            const nsAString &aCharset,
                            eDataFormat aDataFormat,
                            ErrorResult& aRv)
{
  if (IsCurrentThreadRunningWorker() && !mWeakWorkerRef) {
    // The worker is already shutting down.
    return;
  }

  if (mReadyState == LOADING) {
    aRv.Throw(NS_ERROR_DOM_INVALID_STATE_ERR);
    return;
  }

  mError = nullptr;

  SetDOMStringToNull(mResult);
  mResultArrayBuffer = nullptr;

  mAsyncStream = nullptr;

  mTransferred = 0;
  mTotal = 0;
  mReadyState = EMPTY;
  FreeFileData();

  mBlob = &aBlob;
  mDataFormat = aDataFormat;
  CopyUTF16toUTF8(aCharset, mCharset);

  {
    nsCOMPtr<nsIInputStream> stream;
    mBlob->CreateInputStream(getter_AddRefs(stream), aRv);
    if (NS_WARN_IF(aRv.Failed())) {
      return;
    }

    aRv = NS_MakeAsyncNonBlockingInputStream(stream.forget(),
                                             getter_AddRefs(mAsyncStream));
    if (NS_WARN_IF(aRv.Failed())) {
      return;
    }
  }

  MOZ_ASSERT(mAsyncStream);

  mTotal = mBlob->GetSize(aRv);
  if (NS_WARN_IF(aRv.Failed())) {
    return;
  }

  // Binary Format doesn't need a post-processing of the data. Everything is
  // written directly into mResult.
  if (mDataFormat != FILE_AS_BINARY) {
    if (mDataFormat == FILE_AS_ARRAYBUFFER) {
      mFileData = js_pod_malloc<char>(mTotal);
    } else {
      mFileData = (char *) malloc(mTotal);
    }

    if (!mFileData) {
      NS_WARNING("Preallocation failed for ReadFileData");
      aRv.Throw(NS_ERROR_OUT_OF_MEMORY);
      return;
    }
  }

  aRv = DoAsyncWait();
  if (NS_WARN_IF(aRv.Failed())) {
    FreeFileData();
    return;
  }

  //FileReader should be in loading state here
  mReadyState = LOADING;
  DispatchProgressEvent(NS_LITERAL_STRING(LOADSTART_STR));
}

nsresult
FileReader::GetAsText(Blob *aBlob,
                      const nsACString &aCharset,
                      const char *aFileData,
                      uint32_t aDataLen,
                      nsAString& aResult)
{
  // Try the API argument.
  const Encoding* encoding = Encoding::ForLabel(aCharset);
  if (!encoding) {
    // API argument failed. Try the type property of the blob.
    nsAutoString type16;
    aBlob->GetType(type16);
    NS_ConvertUTF16toUTF8 type(type16);
    nsAutoCString specifiedCharset;
    bool haveCharset;
    int32_t charsetStart, charsetEnd;
    NS_ExtractCharsetFromContentType(type,
                                     specifiedCharset,
                                     &haveCharset,
                                     &charsetStart,
                                     &charsetEnd);
    encoding = Encoding::ForLabel(specifiedCharset);
    if (!encoding) {
      // Type property failed. Use UTF-8.
      encoding = UTF_8_ENCODING;
    }
  }

  auto data = MakeSpan(reinterpret_cast<const uint8_t*>(aFileData),
                       aDataLen);
  nsresult rv;
  Tie(rv, encoding) = encoding->Decode(data, aResult);
  return NS_FAILED(rv) ? rv : NS_OK;
}

nsresult
FileReader::GetAsDataURL(Blob *aBlob,
                         const char *aFileData,
                         uint32_t aDataLen,
                         nsAString& aResult)
{
  aResult.AssignLiteral("data:");

  nsAutoString contentType;
  aBlob->GetType(contentType);
  if (!contentType.IsEmpty()) {
    aResult.Append(contentType);
  } else {
    aResult.AppendLiteral("application/octet-stream");
  }
  aResult.AppendLiteral(";base64,");

  nsCString encodedData;
  nsresult rv = Base64Encode(Substring(aFileData, aDataLen), encodedData);
  NS_ENSURE_SUCCESS(rv, rv);

  if (!AppendASCIItoUTF16(encodedData, aResult, fallible)) {
    return NS_ERROR_OUT_OF_MEMORY;
  }

  return NS_OK;
}

/* virtual */ JSObject*
FileReader::WrapObject(JSContext* aCx, JS::Handle<JSObject*> aGivenProto)
{
  return FileReader_Binding::Wrap(aCx, this, aGivenProto);
}

void
FileReader::StartProgressEventTimer()
{
  if (!mProgressNotifier) {
    mProgressNotifier = NS_NewTimer();
  }

  if (mProgressNotifier) {
    mProgressEventWasDelayed = false;
    mTimerIsActive = true;
    mProgressNotifier->Cancel();
    mProgressNotifier->SetTarget(mTarget);
    mProgressNotifier->InitWithCallback(this, NS_PROGRESS_EVENT_INTERVAL,
                                        nsITimer::TYPE_ONE_SHOT);
  }
}

void
FileReader::ClearProgressEventTimer()
{
  mProgressEventWasDelayed = false;
  mTimerIsActive = false;
  if (mProgressNotifier) {
    mProgressNotifier->Cancel();
  }
}

void
FileReader::FreeDataAndDispatchSuccess()
{
  FreeFileData();
  mResult.SetIsVoid(false);
  mAsyncStream = nullptr;
  mBlob = nullptr;

  // Dispatch event to signify end of a successful operation
  DispatchProgressEvent(NS_LITERAL_STRING(LOAD_STR));
  DispatchProgressEvent(NS_LITERAL_STRING(LOADEND_STR));
}

void
FileReader::FreeDataAndDispatchError()
{
  MOZ_ASSERT(mError);

  FreeFileData();
  mResult.SetIsVoid(true);
  mAsyncStream = nullptr;
  mBlob = nullptr;

  // Dispatch error event to signify load failure
  DispatchProgressEvent(NS_LITERAL_STRING(ERROR_STR));
  DispatchProgressEvent(NS_LITERAL_STRING(LOADEND_STR));
}

void
FileReader::FreeDataAndDispatchError(nsresult aRv)
{
  // Set the status attribute, and dispatch the error event
  switch (aRv) {
  case NS_ERROR_FILE_NOT_FOUND:
    mError = DOMException::Create(NS_ERROR_DOM_NOT_FOUND_ERR);
    break;
  case NS_ERROR_FILE_ACCESS_DENIED:
    mError = DOMException::Create(NS_ERROR_DOM_SECURITY_ERR);
    break;
  default:
    mError = DOMException::Create(NS_ERROR_DOM_FILE_NOT_READABLE_ERR);
    break;
  }

  FreeDataAndDispatchError();
}

nsresult
FileReader::DispatchProgressEvent(const nsAString& aType)
{
  ProgressEventInit init;
  init.mBubbles = false;
  init.mCancelable = false;
  init.mLoaded = mTransferred;

  if (mTotal != kUnknownSize) {
    init.mLengthComputable = true;
    init.mTotal = mTotal;
  } else {
    init.mLengthComputable = false;
    init.mTotal = 0;
  }
  RefPtr<ProgressEvent> event =
    ProgressEvent::Constructor(this, aType, init);
  event->SetTrusted(true);

  ErrorResult rv;
  DispatchEvent(*event, rv);
  return rv.StealNSResult();
}

// nsITimerCallback
NS_IMETHODIMP
FileReader::Notify(nsITimer* aTimer)
{
  nsresult rv;
  mTimerIsActive = false;

  if (mProgressEventWasDelayed) {
    rv = DispatchProgressEvent(NS_LITERAL_STRING("progress"));
    NS_ENSURE_SUCCESS(rv, rv);

    StartProgressEventTimer();
  }

  return NS_OK;
}

// InputStreamCallback
NS_IMETHODIMP
FileReader::OnInputStreamReady(nsIAsyncInputStream* aStream)
{
  if (mReadyState != LOADING || aStream != mAsyncStream) {
    return NS_OK;
  }

  // We use this class to decrease the busy counter at the end of this method.
  // In theory we can do it immediatelly but, for debugging reasons, we want to
  // be 100% sure we have a workerRef when OnLoadEnd() is called.
  FileReaderDecreaseBusyCounter RAII(this);

  uint64_t count;
  nsresult rv = aStream->Available(&count);

  if (NS_SUCCEEDED(rv) && count) {
    rv = DoReadData(count);

    if (NS_SUCCEEDED(rv)) {
      rv = DoAsyncWait();
    }
  }

  if (NS_FAILED(rv) || !count) {
    if (rv == NS_BASE_STREAM_CLOSED) {
      rv = NS_OK;
    }
    return OnLoadEnd(rv);
  }

  mTransferred += count;

  //Notify the timer is the appropriate timeframe has passed
  if (mTimerIsActive) {
    mProgressEventWasDelayed = true;
  } else {
    rv = DispatchProgressEvent(NS_LITERAL_STRING(PROGRESS_STR));
    NS_ENSURE_SUCCESS(rv, rv);

    StartProgressEventTimer();
  }

  return NS_OK;
}

// nsINamed
NS_IMETHODIMP
FileReader::GetName(nsACString& aName)
{
  aName.AssignLiteral("FileReader");
  return NS_OK;
}

nsresult
FileReader::OnLoadEnd(nsresult aStatus)
{
  // Cancel the progress event timer
  ClearProgressEventTimer();

  // FileReader must be in DONE stage after an operation
  mReadyState = DONE;

  // Quick return, if failed.
  if (NS_FAILED(aStatus)) {
    FreeDataAndDispatchError(aStatus);
    return NS_OK;
  }

  // In case we read a different number of bytes, we can assume that the
  // underlying storage has changed. We should not continue.
  if (mDataLen != mTotal) {
    FreeDataAndDispatchError(NS_ERROR_FAILURE);
    return NS_OK;
  }

  // ArrayBuffer needs a custom handling.
  if (mDataFormat == FILE_AS_ARRAYBUFFER) {
    OnLoadEndArrayBuffer();
    return NS_OK;
  }

  nsresult rv = NS_OK;

  // We don't do anything special for Binary format.

  if (mDataFormat == FILE_AS_DATAURL) {
    rv = GetAsDataURL(mBlob, mFileData, mDataLen, mResult);
  } else if (mDataFormat == FILE_AS_TEXT) {
    if (!mFileData && mDataLen) {
      rv = NS_ERROR_OUT_OF_MEMORY;
    } else if (!mFileData) {
      rv = GetAsText(mBlob, mCharset, "", mDataLen, mResult);
    } else {
      rv = GetAsText(mBlob, mCharset, mFileData, mDataLen, mResult);
    }
  }

  if (NS_WARN_IF(NS_FAILED(rv))) {
    FreeDataAndDispatchError(rv);
    return NS_OK;
  }

  FreeDataAndDispatchSuccess();
  return NS_OK;
}

void
FileReader::Abort()
{
  if (mReadyState == EMPTY || mReadyState == DONE) {
    return;
  }

  MOZ_ASSERT(mReadyState == LOADING);

  ClearProgressEventTimer();

  mReadyState = DONE;

  // XXX The spec doesn't say this
  mError = DOMException::Create(NS_ERROR_DOM_ABORT_ERR);

  // Revert status and result attributes
  SetDOMStringToNull(mResult);
  mResultArrayBuffer = nullptr;

  mAsyncStream = nullptr;
  mBlob = nullptr;

  //Clean up memory buffer
  FreeFileData();

  // Dispatch the events
  DispatchProgressEvent(NS_LITERAL_STRING(ABORT_STR));
  DispatchProgressEvent(NS_LITERAL_STRING(LOADEND_STR));
}

nsresult
FileReader::IncreaseBusyCounter()
{
  if (mWeakWorkerRef && mBusyCount++ == 0) {
    if (NS_WARN_IF(!mWeakWorkerRef->GetPrivate())) {
      return NS_ERROR_FAILURE;
    }

    RefPtr<FileReader> self = this;

    RefPtr<StrongWorkerRef> ref =
      StrongWorkerRef::Create(mWeakWorkerRef->GetPrivate(), "FileReader",
                              [self]() { self->Shutdown(); });
    if (NS_WARN_IF(!ref)) {
      return NS_ERROR_FAILURE;
    }

    mStrongWorkerRef = ref;
  }

  return NS_OK;
}

void
FileReader::DecreaseBusyCounter()
{
  MOZ_ASSERT_IF(mStrongWorkerRef, mBusyCount);
  if (mStrongWorkerRef && --mBusyCount == 0) {
    mStrongWorkerRef = nullptr;
  }
}

void
FileReader::Shutdown()
{
  mReadyState = DONE;

  if (mAsyncStream) {
    mAsyncStream->Close();
    mAsyncStream = nullptr;
  }

  FreeFileData();
  mResultArrayBuffer = nullptr;

  if (mWeakWorkerRef && mBusyCount != 0) {
    mStrongWorkerRef = nullptr;
    mWeakWorkerRef = nullptr;
    mBusyCount = 0;
  }
}

} // dom namespace
} // mozilla namespace
