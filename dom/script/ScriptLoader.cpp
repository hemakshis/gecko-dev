/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ScriptLoader.h"
#include "ScriptLoadHandler.h"
#include "ScriptLoadRequest.h"
#include "ScriptTrace.h"
#include "ModuleLoadRequest.h"
#include "ModuleScript.h"

#include "prsystem.h"
#include "jsapi.h"
#include "jsfriendapi.h"
#include "js/Utility.h"
#include "xpcpublic.h"
#include "nsCycleCollectionParticipant.h"
#include "nsIContent.h"
#include "nsJSUtils.h"
#include "mozilla/dom/DocGroup.h"
#include "mozilla/dom/Element.h"
#include "mozilla/dom/ScriptSettings.h"
#include "mozilla/dom/SRILogHelper.h"
#include "nsGkAtoms.h"
#include "nsNetUtil.h"
#include "nsIScriptGlobalObject.h"
#include "nsIScriptContext.h"
#include "nsIScriptSecurityManager.h"
#include "nsIPrincipal.h"
#include "nsJSPrincipals.h"
#include "nsContentPolicyUtils.h"
#include "nsIHttpChannel.h"
#include "nsIHttpChannelInternal.h"
#include "nsIClassOfService.h"
#include "nsICacheInfoChannel.h"
#include "nsITimedChannel.h"
#include "nsIScriptElement.h"
#include "nsIDocShell.h"
#include "nsContentUtils.h"
#include "nsUnicharUtils.h"
#include "nsAutoPtr.h"
#include "nsIXPConnect.h"
#include "nsError.h"
#include "nsThreadUtils.h"
#include "nsDocShellCID.h"
#include "nsIContentSecurityPolicy.h"
#include "mozilla/Logging.h"
#include "nsCRT.h"
#include "nsContentCreatorFunctions.h"
#include "nsProxyRelease.h"
#include "nsSandboxFlags.h"
#include "nsContentTypeParser.h"
#include "nsINetworkPredictor.h"
#include "nsMimeTypes.h"
#include "mozilla/ConsoleReportCollector.h"
#include "mozilla/LoadInfo.h"

#include "mozilla/AsyncEventDispatcher.h"
#include "mozilla/Attributes.h"
#include "mozilla/Telemetry.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/Unused.h"
#include "nsIScriptError.h"
#include "nsIOutputStream.h"

using JS::SourceBufferHolder;

using mozilla::Telemetry::LABELS_DOM_SCRIPT_PRELOAD_RESULT;

namespace mozilla {
namespace dom {

LazyLogModule ScriptLoader::gCspPRLog("CSP");
LazyLogModule ScriptLoader::gScriptLoaderLog("ScriptLoader");

#undef LOG
#define LOG(args) \
  MOZ_LOG(ScriptLoader::gScriptLoaderLog, mozilla::LogLevel::Debug, args)

#define LOG_ENABLED() \
  MOZ_LOG_TEST(ScriptLoader::gScriptLoaderLog, mozilla::LogLevel::Debug)

// Alternate Data MIME type used by the ScriptLoader to register that we want to
// store bytecode without reading it.
static NS_NAMED_LITERAL_CSTRING(kNullMimeType, "javascript/null");

//////////////////////////////////////////////////////////////
// ScriptLoader::PreloadInfo
//////////////////////////////////////////////////////////////

inline void
ImplCycleCollectionUnlink(ScriptLoader::PreloadInfo& aField)
{
  ImplCycleCollectionUnlink(aField.mRequest);
}

inline void
ImplCycleCollectionTraverse(nsCycleCollectionTraversalCallback& aCallback,
                            ScriptLoader::PreloadInfo& aField,
                            const char* aName,
                            uint32_t aFlags = 0)
{
  ImplCycleCollectionTraverse(aCallback, aField.mRequest, aName, aFlags);
}

//////////////////////////////////////////////////////////////
// ScriptLoader
//////////////////////////////////////////////////////////////

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(ScriptLoader)
NS_INTERFACE_MAP_END

NS_IMPL_CYCLE_COLLECTION(ScriptLoader,
                         mNonAsyncExternalScriptInsertedRequests,
                         mLoadingAsyncRequests,
                         mLoadedAsyncRequests,
                         mDeferRequests,
                         mXSLTRequests,
                         mParserBlockingRequest,
                         mBytecodeEncodingQueue,
                         mPreloads,
                         mPendingChildLoaders,
                         mFetchedModules)

NS_IMPL_CYCLE_COLLECTING_ADDREF(ScriptLoader)
NS_IMPL_CYCLE_COLLECTING_RELEASE(ScriptLoader)

ScriptLoader::ScriptLoader(nsIDocument *aDocument)
  : mDocument(aDocument),
    mParserBlockingBlockerCount(0),
    mBlockerCount(0),
    mNumberOfProcessors(0),
    mEnabled(true),
    mDeferEnabled(false),
    mDocumentParsingDone(false),
    mBlockingDOMContentLoaded(false),
    mLoadEventFired(false),
    mGiveUpEncoding(false),
    mReporter(new ConsoleReportCollector())
{
  LOG(("ScriptLoader::ScriptLoader %p", this));
}

ScriptLoader::~ScriptLoader()
{
  LOG(("ScriptLoader::~ScriptLoader %p", this));

  mObservers.Clear();

  if (mParserBlockingRequest) {
    mParserBlockingRequest->FireScriptAvailable(NS_ERROR_ABORT);
  }

  for (ScriptLoadRequest* req = mXSLTRequests.getFirst(); req;
       req = req->getNext()) {
    req->FireScriptAvailable(NS_ERROR_ABORT);
  }

  for (ScriptLoadRequest* req = mDeferRequests.getFirst(); req;
       req = req->getNext()) {
    req->FireScriptAvailable(NS_ERROR_ABORT);
  }

  for (ScriptLoadRequest* req = mLoadingAsyncRequests.getFirst(); req;
       req = req->getNext()) {
    req->FireScriptAvailable(NS_ERROR_ABORT);
  }

  for (ScriptLoadRequest* req = mLoadedAsyncRequests.getFirst(); req;
       req = req->getNext()) {
    req->FireScriptAvailable(NS_ERROR_ABORT);
  }

  for(ScriptLoadRequest* req = mNonAsyncExternalScriptInsertedRequests.getFirst();
      req;
      req = req->getNext()) {
    req->FireScriptAvailable(NS_ERROR_ABORT);
  }

  // Unblock the kids, in case any of them moved to a different document
  // subtree in the meantime and therefore aren't actually going away.
  for (uint32_t j = 0; j < mPendingChildLoaders.Length(); ++j) {
    mPendingChildLoaders[j]->RemoveParserBlockingScriptExecutionBlocker();
  }

  for (size_t i = 0; i < mPreloads.Length(); i++) {
    AccumulateCategorical(LABELS_DOM_SCRIPT_PRELOAD_RESULT::NotUsed);
  }
}

// Collect telemtry data about the cache information, and the kind of source
// which are being loaded, and where it is being loaded from.
static void
CollectScriptTelemetry(ScriptLoadRequest* aRequest)
{
  using namespace mozilla::Telemetry;

  // Skip this function if we are not running telemetry.
  if (!CanRecordExtended()) {
    return;
  }

  // Report the script kind.
  if (aRequest->IsModuleRequest()) {
    AccumulateCategorical(LABELS_DOM_SCRIPT_KIND::ModuleScript);
  } else {
    AccumulateCategorical(LABELS_DOM_SCRIPT_KIND::ClassicScript);
  }

  // Report the type of source. This is used to monitor the status of the
  // JavaScript Start-up Bytecode Cache, with the expectation of an almost zero
  // source-fallback and alternate-data being roughtly equal to source loads.
  if (aRequest->IsLoadingSource()) {
    if (aRequest->mIsInline) {
      AccumulateCategorical(LABELS_DOM_SCRIPT_LOADING_SOURCE::Inline);
      nsAutoString inlineData;
      aRequest->Element()->GetScriptText(inlineData);
    } else if (aRequest->IsTextSource()) {
      AccumulateCategorical(LABELS_DOM_SCRIPT_LOADING_SOURCE::SourceFallback);
    }
    // TODO: Add telemetry for BinAST encoded source.
  } else {
    MOZ_ASSERT(aRequest->IsLoading());
    if (aRequest->IsTextSource()) {
      AccumulateCategorical(LABELS_DOM_SCRIPT_LOADING_SOURCE::Source);
    } else if (aRequest->IsBytecode()) {
      AccumulateCategorical(LABELS_DOM_SCRIPT_LOADING_SOURCE::AltData);
    }
    // TODO: Add telemetry for BinAST encoded source.
  }
}

// Helper method for checking if the script element is an event-handler
// This means that it has both a for-attribute and a event-attribute.
// Also, if the for-attribute has a value that matches "\s*window\s*",
// and the event-attribute matches "\s*onload([ \(].*)?" then it isn't an
// eventhandler. (both matches are case insensitive).
// This is how IE seems to filter out a window's onload handler from a
// <script for=... event=...> element.

static bool
IsScriptEventHandler(ScriptKind kind, nsIContent* aScriptElement)
{
  if (kind != ScriptKind::eClassic) {
    return false;
  }

  if (!aScriptElement->IsHTMLElement()) {
    return false;
  }

  nsAutoString forAttr, eventAttr;
  if (!aScriptElement->AsElement()->GetAttr(kNameSpaceID_None,
                                            nsGkAtoms::_for,
                                            forAttr) ||
      !aScriptElement->AsElement()->GetAttr(kNameSpaceID_None,
                                            nsGkAtoms::event,
                                            eventAttr)) {
    return false;
  }

  const nsAString& for_str =
    nsContentUtils::TrimWhitespace<nsCRT::IsAsciiSpace>(forAttr);
  if (!for_str.LowerCaseEqualsLiteral("window")) {
    return true;
  }

  // We found for="window", now check for event="onload".
  const nsAString& event_str =
    nsContentUtils::TrimWhitespace<nsCRT::IsAsciiSpace>(eventAttr, false);
  if (!StringBeginsWith(event_str, NS_LITERAL_STRING("onload"),
                        nsCaseInsensitiveStringComparator())) {
    // It ain't "onload.*".

    return true;
  }

  nsAutoString::const_iterator start, end;
  event_str.BeginReading(start);
  event_str.EndReading(end);

  start.advance(6); // advance past "onload"

  if (start != end && *start != '(' && *start != ' ') {
    // We got onload followed by something other than space or
    // '('. Not good enough.

    return true;
  }

  return false;
}

nsresult
ScriptLoader::CheckContentPolicy(nsIDocument* aDocument,
                                 nsISupports* aContext,
                                 nsIURI* aURI,
                                 const nsAString& aType,
                                 bool aIsPreLoad)
{
  nsContentPolicyType contentPolicyType = aIsPreLoad
                                          ? nsIContentPolicy::TYPE_INTERNAL_SCRIPT_PRELOAD
                                          : nsIContentPolicy::TYPE_INTERNAL_SCRIPT;

  nsCOMPtr<nsINode> requestingNode = do_QueryInterface(aContext);
  nsCOMPtr<nsILoadInfo> secCheckLoadInfo =
    new net::LoadInfo(aDocument->NodePrincipal(), // loading principal
                      aDocument->NodePrincipal(), // triggering principal
                      requestingNode,
                      nsILoadInfo::SEC_ONLY_FOR_EXPLICIT_CONTENTSEC_CHECK,
                      contentPolicyType);

  int16_t shouldLoad = nsIContentPolicy::ACCEPT;
  nsresult rv = NS_CheckContentLoadPolicy(aURI, secCheckLoadInfo,
                                          NS_LossyConvertUTF16toASCII(aType),
                                          &shouldLoad,
                                          nsContentUtils::GetContentPolicy());
  if (NS_FAILED(rv) || NS_CP_REJECTED(shouldLoad)) {
    if (NS_FAILED(rv) || shouldLoad != nsIContentPolicy::REJECT_TYPE) {
      return NS_ERROR_CONTENT_BLOCKED;
    }
    return NS_ERROR_CONTENT_BLOCKED_SHOW_ALT;
  }

  return NS_OK;
}

bool
ScriptLoader::ModuleMapContainsURL(nsIURI* aURL) const
{
  // Returns whether we have fetched, or are currently fetching, a module script
  // for a URL.
  return mFetchingModules.Contains(aURL) ||
         mFetchedModules.Contains(aURL);
}

bool
ScriptLoader::IsFetchingModule(ModuleLoadRequest* aRequest) const
{
  bool fetching = mFetchingModules.Contains(aRequest->mURI);
  MOZ_ASSERT_IF(fetching, !mFetchedModules.Contains(aRequest->mURI));
  return fetching;
}

void
ScriptLoader::SetModuleFetchStarted(ModuleLoadRequest* aRequest)
{
  // Update the module map to indicate that a module is currently being fetched.

  MOZ_ASSERT(aRequest->IsLoading());
  MOZ_ASSERT(!ModuleMapContainsURL(aRequest->mURI));
  mFetchingModules.Put(aRequest->mURI, nullptr);
}

void
ScriptLoader::SetModuleFetchFinishedAndResumeWaitingRequests(ModuleLoadRequest* aRequest,
                                                             nsresult aResult)
{
  // Update module map with the result of fetching a single module script.
  //
  // If any requests for the same URL are waiting on this one to complete, they
  // will have ModuleLoaded or LoadFailed on them when the promise is
  // resolved/rejected. This is set up in StartLoad.

  LOG(("ScriptLoadRequest (%p): Module fetch finished (script == %p, result == %u)",
       aRequest, aRequest->mModuleScript.get(), unsigned(aResult)));

  RefPtr<GenericPromise::Private> promise;
  MOZ_ALWAYS_TRUE(mFetchingModules.Remove(aRequest->mURI, getter_AddRefs(promise)));

  RefPtr<ModuleScript> moduleScript(aRequest->mModuleScript);
  MOZ_ASSERT(NS_FAILED(aResult) == !moduleScript);

  mFetchedModules.Put(aRequest->mURI, moduleScript);

  if (promise) {
    if (moduleScript) {
      LOG(("ScriptLoadRequest (%p):   resolving %p", aRequest, promise.get()));
      promise->Resolve(true, __func__);
    } else {
      LOG(("ScriptLoadRequest (%p):   rejecting %p", aRequest, promise.get()));
      promise->Reject(aResult, __func__);
    }
  }
}

RefPtr<GenericPromise>
ScriptLoader::WaitForModuleFetch(nsIURI* aURL)
{
  MOZ_ASSERT(ModuleMapContainsURL(aURL));

  if (auto entry = mFetchingModules.Lookup(aURL)) {
    if (!entry.Data()) {
      entry.Data() = new GenericPromise::Private(__func__);
    }
    return entry.Data();
  }

  RefPtr<ModuleScript> ms;
  MOZ_ALWAYS_TRUE(mFetchedModules.Get(aURL, getter_AddRefs(ms)));
  if (!ms) {
    return GenericPromise::CreateAndReject(NS_ERROR_FAILURE, __func__);
  }

  return GenericPromise::CreateAndResolve(true, __func__);
}

ModuleScript*
ScriptLoader::GetFetchedModule(nsIURI* aURL) const
{
  if (LOG_ENABLED()) {
    nsAutoCString url;
    aURL->GetAsciiSpec(url);
    LOG(("GetFetchedModule %s", url.get()));
  }

  bool found;
  ModuleScript* ms = mFetchedModules.GetWeak(aURL, &found);
  MOZ_ASSERT(found);
  return ms;
}

nsresult
ScriptLoader::ProcessFetchedModuleSource(ModuleLoadRequest* aRequest)
{
  MOZ_ASSERT(!aRequest->mModuleScript);

  nsresult rv = CreateModuleScript(aRequest);
  MOZ_ASSERT(NS_FAILED(rv) == !aRequest->mModuleScript);

  aRequest->ClearScriptSource();

  if (NS_FAILED(rv)) {
    aRequest->LoadFailed();
    return rv;
  }

  if (!aRequest->mIsInline) {
    SetModuleFetchFinishedAndResumeWaitingRequests(aRequest, rv);
  }

  if (!aRequest->mModuleScript->HasParseError()) {
    StartFetchingModuleDependencies(aRequest);
  }

  return NS_OK;
}

static nsresult
ResolveRequestedModules(ModuleLoadRequest* aRequest, nsCOMArray<nsIURI>* aUrlsOut);

nsresult
ScriptLoader::CreateModuleScript(ModuleLoadRequest* aRequest)
{
  MOZ_ASSERT(!aRequest->mModuleScript);
  MOZ_ASSERT(aRequest->mBaseURL);

  LOG(("ScriptLoadRequest (%p): Create module script", aRequest));

  nsCOMPtr<nsIScriptGlobalObject> globalObject = GetScriptGlobalObject();
  if (!globalObject) {
    return NS_ERROR_FAILURE;
  }

  nsCOMPtr<nsIScriptContext> context = globalObject->GetScriptContext();
  if (!context) {
    return NS_ERROR_FAILURE;
  }

  nsAutoMicroTask mt;
  AutoEntryScript aes(globalObject, "CompileModule", true);

  bool oldProcessingScriptTag = context->GetProcessingScriptTag();
  context->SetProcessingScriptTag(true);

  nsresult rv;
  {
    JSContext* cx = aes.cx();
    JS::Rooted<JSScript*> script(cx);

    if (aRequest->mWasCompiledOMT) {
      script = JS::FinishOffThreadModule(cx, aRequest->mOffThreadToken);
      aRequest->mOffThreadToken = nullptr;
      rv = script ? NS_OK : NS_ERROR_FAILURE;
    } else {
      JS::Rooted<JSObject*> global(cx, globalObject->GetGlobalJSObject());

      JS::CompileOptions options(cx);
      rv = FillCompileOptionsForRequest(aes, aRequest, global, &options);

      if (NS_SUCCEEDED(rv)) {
        auto srcBuf = GetScriptSource(cx, aRequest);
        if (srcBuf) {
          rv = nsJSUtils::CompileModule(cx, *srcBuf, global, options, &script);
        } else {
          rv = NS_ERROR_OUT_OF_MEMORY;
        }
      }
    }

    MOZ_ASSERT(NS_SUCCEEDED(rv) == (script != nullptr));

    RefPtr<ModuleScript> moduleScript = new ModuleScript(this, aRequest->mBaseURL);
    aRequest->mModuleScript = moduleScript;

    if (!script) {
      LOG(("ScriptLoadRequest (%p):   compilation failed (%d)",
           aRequest, unsigned(rv)));

      MOZ_ASSERT(aes.HasException());
      JS::Rooted<JS::Value> error(cx);
      if (!aes.StealException(&error)) {
        aRequest->mModuleScript = nullptr;
        return NS_ERROR_FAILURE;
      }

      moduleScript->SetParseError(error);
      aRequest->ModuleErrored();
      return NS_OK;
    }

    moduleScript->SetScript(script);

    // Validate requested modules and treat failure to resolve module specifiers
    // the same as a parse error.
    rv = ResolveRequestedModules(aRequest, nullptr);
    if (NS_FAILED(rv)) {
      aRequest->ModuleErrored();
      return NS_OK;
    }
  }

  context->SetProcessingScriptTag(oldProcessingScriptTag);

  LOG(("ScriptLoadRequest (%p):   module script == %p",
       aRequest, aRequest->mModuleScript.get()));

  return rv;
}

static nsresult
HandleResolveFailure(JSContext* aCx, ModuleScript* aScript,
                     const nsAString& aSpecifier,
                     uint32_t aLineNumber, uint32_t aColumnNumber)
{
  nsAutoCString url;
  aScript->BaseURL()->GetAsciiSpec(url);

  JS::Rooted<JSString*> filename(aCx);
  filename = JS_NewStringCopyZ(aCx, url.get());
  if (!filename) {
    return NS_ERROR_OUT_OF_MEMORY;
  }

  nsAutoString message(NS_LITERAL_STRING("Error resolving module specifier: "));
  message.Append(aSpecifier);

  JS::Rooted<JSString*> string(aCx, JS_NewUCStringCopyZ(aCx, message.get()));
  if (!string) {
    return NS_ERROR_OUT_OF_MEMORY;
  }

  JS::Rooted<JS::Value> error(aCx);
  if (!JS::CreateError(aCx, JSEXN_TYPEERR, nullptr, filename, aLineNumber,
                       aColumnNumber, nullptr, string, &error))
  {
    return NS_ERROR_OUT_OF_MEMORY;
  }

  aScript->SetParseError(error);
  return NS_OK;
}

static already_AddRefed<nsIURI>
ResolveModuleSpecifier(ModuleScript* aScript,
                       const nsAString& aSpecifier)
{
  // The following module specifiers are allowed by the spec:
  //  - a valid absolute URL
  //  - a valid relative URL that starts with "/", "./" or "../"
  //
  // Bareword module specifiers are currently disallowed as these may be given
  // special meanings in the future.

  nsCOMPtr<nsIURI> uri;
  nsresult rv = NS_NewURI(getter_AddRefs(uri), aSpecifier);
  if (NS_SUCCEEDED(rv)) {
    return uri.forget();
  }

  if (rv != NS_ERROR_MALFORMED_URI) {
    return nullptr;
  }

  if (!StringBeginsWith(aSpecifier, NS_LITERAL_STRING("/")) &&
      !StringBeginsWith(aSpecifier, NS_LITERAL_STRING("./")) &&
      !StringBeginsWith(aSpecifier, NS_LITERAL_STRING("../"))) {
    return nullptr;
  }

  rv = NS_NewURI(getter_AddRefs(uri), aSpecifier, nullptr, aScript->BaseURL());
  if (NS_SUCCEEDED(rv)) {
    return uri.forget();
  }

  return nullptr;
}

static nsresult
ResolveRequestedModules(ModuleLoadRequest* aRequest, nsCOMArray<nsIURI>* aUrlsOut)
{
  ModuleScript* ms = aRequest->mModuleScript;

  AutoJSAPI jsapi;
  if (!jsapi.Init(JS::GetScriptGlobal(ms->Script()))) {
    return NS_ERROR_FAILURE;
  }

  JSContext* cx = jsapi.cx();
  JS::Rooted<JSScript*> script(cx, ms->Script());
  JS::Rooted<JSObject*> requestedModules(cx);
  requestedModules = JS::GetRequestedModules(cx, script);
  MOZ_ASSERT(requestedModules);

  uint32_t length;
  if (!JS_GetArrayLength(cx, requestedModules, &length)) {
    return NS_ERROR_FAILURE;
  }

  JS::Rooted<JS::Value> element(cx);
  for (uint32_t i = 0; i < length; i++) {
    if (!JS_GetElement(cx, requestedModules, i, &element)) {
      return NS_ERROR_FAILURE;
    }

    JS::Rooted<JSString*> str(cx, JS::GetRequestedModuleSpecifier(cx, element));
    MOZ_ASSERT(str);

    nsAutoJSString specifier;
    if (!specifier.init(cx, str)) {
      return NS_ERROR_FAILURE;
    }

    // Let url be the result of resolving a module specifier given module script and requested.
    nsCOMPtr<nsIURI> uri = ResolveModuleSpecifier(ms, specifier);
    if (!uri) {
      uint32_t lineNumber = 0;
      uint32_t columnNumber = 0;
      JS::GetRequestedModuleSourcePos(cx, element, &lineNumber, &columnNumber);

      nsresult rv = HandleResolveFailure(cx, ms, specifier, lineNumber, columnNumber);
      NS_ENSURE_SUCCESS(rv, rv);
      return NS_ERROR_FAILURE;
    }

    if (aUrlsOut) {
      aUrlsOut->AppendElement(uri.forget());
    }
  }

  return NS_OK;
}

void
ScriptLoader::StartFetchingModuleDependencies(ModuleLoadRequest* aRequest)
{
  LOG(("ScriptLoadRequest (%p): Start fetching module dependencies", aRequest));

  MOZ_ASSERT(aRequest->mModuleScript);
  MOZ_ASSERT(!aRequest->mModuleScript->HasParseError());
  MOZ_ASSERT(!aRequest->IsReadyToRun());

  auto visitedSet = aRequest->mVisitedSet;
  MOZ_ASSERT(visitedSet->Contains(aRequest->mURI));

  aRequest->mProgress = ModuleLoadRequest::Progress::eFetchingImports;

  nsCOMArray<nsIURI> urls;
  nsresult rv = ResolveRequestedModules(aRequest, &urls);
  if (NS_FAILED(rv)) {
    aRequest->ModuleErrored();
    return;
  }

  // Remove already visited URLs from the list. Put unvisited URLs into the
  // visited set.
  int32_t i = 0;
  while (i < urls.Count()) {
    nsIURI* url = urls[i];
    if (visitedSet->Contains(url)) {
      urls.RemoveObjectAt(i);
    } else {
      visitedSet->PutEntry(url);
      i++;
    }
  }

  if (urls.Count() == 0) {
    // There are no descendants to load so this request is ready.
    aRequest->DependenciesLoaded();
    return;
  }

  // For each url in urls, fetch a module script tree given url, module script's
  // CORS setting, and module script's settings object.
  nsTArray<RefPtr<GenericPromise>> importsReady;
  for (auto url : urls) {
    RefPtr<GenericPromise> childReady =
      StartFetchingModuleAndDependencies(aRequest, url);
    importsReady.AppendElement(childReady);
  }

  // Wait for all imports to become ready.
  RefPtr<GenericPromise::AllPromiseType> allReady =
    GenericPromise::All(GetMainThreadSerialEventTarget(), importsReady);
  allReady->Then(GetMainThreadSerialEventTarget(), __func__, aRequest,
                 &ModuleLoadRequest::DependenciesLoaded,
                 &ModuleLoadRequest::ModuleErrored);
}

RefPtr<GenericPromise>
ScriptLoader::StartFetchingModuleAndDependencies(ModuleLoadRequest* aParent,
                                                 nsIURI* aURI)
{
  MOZ_ASSERT(aURI);

  RefPtr<ModuleLoadRequest> childRequest = new ModuleLoadRequest(aURI, aParent);

  aParent->mImports.AppendElement(childRequest);

  if (LOG_ENABLED()) {
    nsAutoCString url1;
    aParent->mURI->GetAsciiSpec(url1);

    nsAutoCString url2;
    aURI->GetAsciiSpec(url2);

    LOG(("ScriptLoadRequest (%p): Start fetching dependency %p", aParent, childRequest.get()));
    LOG(("StartFetchingModuleAndDependencies \"%s\" -> \"%s\"", url1.get(), url2.get()));
  }

  RefPtr<GenericPromise> ready = childRequest->mReady.Ensure(__func__);

  nsresult rv = StartLoad(childRequest);
  if (NS_FAILED(rv)) {
    MOZ_ASSERT(!childRequest->mModuleScript);
    LOG(("ScriptLoadRequest (%p):   rejecting %p", aParent, &childRequest->mReady));
    childRequest->mReady.Reject(rv, __func__);
    return ready;
  }

  return ready;
}

// 8.1.3.8.1 HostResolveImportedModule(referencingModule, specifier)
JSScript*
HostResolveImportedModule(JSContext* aCx, JS::Handle<JSScript*> aScript,
                          JS::Handle<JSString*> aSpecifier)
{
  // Let referencing module script be referencingModule.[[HostDefined]].
  void* value = JS::GetTopLevelScriptPrivate(aScript);
  if (!value) {
    JS_ReportErrorASCII(aCx, "Module script not found");
    return nullptr;
  }

  auto script = static_cast<ModuleScript*>(value);
  MOZ_ASSERT(script->Script() == aScript);

  // Let url be the result of resolving a module specifier given referencing
  // module script and specifier.
  nsAutoJSString string;
  if (!string.init(aCx, aSpecifier)) {
    return nullptr;
  }

  nsCOMPtr<nsIURI> uri = ResolveModuleSpecifier(script, string);

  // This cannot fail because resolving a module specifier must have been
  // previously successful with these same two arguments.
  MOZ_ASSERT(uri, "Failed to resolve previously-resolved module specifier");

  // Let resolved module script be moduleMap[url]. (This entry must exist for us
  // to have gotten to this point.)
  ModuleScript* ms = script->Loader()->GetFetchedModule(uri);
  MOZ_ASSERT(ms, "Resolved module not found in module map");

  MOZ_ASSERT(!ms->HasParseError());
  MOZ_ASSERT(ms->Script());

  return ms->Script();
}

bool
HostPopulateImportMeta(JSContext* aCx, JS::Handle<JSScript*> aScript,
                       JS::Handle<JSObject*> aMetaObject)
{
  MOZ_DIAGNOSTIC_ASSERT(aScript);

  void* value = JS::GetTopLevelScriptPrivate(aScript);
  if (!value) {
    JS_ReportErrorASCII(aCx, "Module script not found");
    return false;
  }

  auto script = static_cast<ModuleScript*>(value);
  MOZ_DIAGNOSTIC_ASSERT(script->Script() == aScript);

  nsAutoCString url;
  MOZ_DIAGNOSTIC_ASSERT(script->BaseURL());
  MOZ_ALWAYS_SUCCEEDS(script->BaseURL()->GetAsciiSpec(url));

  JS::Rooted<JSString*> urlString(aCx, JS_NewStringCopyZ(aCx, url.get()));
  if (!urlString) {
    JS_ReportOutOfMemory(aCx);
    return false;
  }

  return JS_DefineProperty(aCx, aMetaObject, "url", urlString, JSPROP_ENUMERATE);
}

static void
EnsureModuleResolveHook(JSContext* aCx)
{
  JSRuntime* rt = JS_GetRuntime(aCx);
  if (JS::GetModuleResolveHook(rt)) {
    return;
  }

  JS::SetModuleResolveHook(rt, HostResolveImportedModule);
  JS::SetModuleMetadataHook(rt, HostPopulateImportMeta);
}

void
ScriptLoader::CheckModuleDependenciesLoaded(ModuleLoadRequest* aRequest)
{
  LOG(("ScriptLoadRequest (%p): Check dependencies loaded", aRequest));

  RefPtr<ModuleScript> moduleScript = aRequest->mModuleScript;
  if (!moduleScript || moduleScript->HasParseError()) {
    return;
  }

  for (auto childRequest : aRequest->mImports) {
    ModuleScript* childScript = childRequest->mModuleScript;
    if (!childScript) {
      aRequest->mModuleScript = nullptr;
      LOG(("ScriptLoadRequest (%p):   %p failed (load error)", aRequest, childRequest.get()));
      return;
    }
  }

 LOG(("ScriptLoadRequest (%p):   all ok", aRequest));
}

class ScriptRequestProcessor : public Runnable
{
private:
  RefPtr<ScriptLoader> mLoader;
  RefPtr<ScriptLoadRequest> mRequest;
public:
  ScriptRequestProcessor(ScriptLoader* aLoader, ScriptLoadRequest* aRequest)
    : Runnable("dom::ScriptRequestProcessor")
    , mLoader(aLoader)
    , mRequest(aRequest)
  {}
  NS_IMETHOD Run() override
  {
    return mLoader->ProcessRequest(mRequest);
  }
};

void
ScriptLoader::ProcessLoadedModuleTree(ModuleLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest->IsReadyToRun());

  if (aRequest->IsTopLevel()) {
    if (aRequest->mIsInline &&
        aRequest->Element()->GetParserCreated() == NOT_FROM_PARSER)
    {
      MOZ_ASSERT(!aRequest->isInList());
      nsContentUtils::AddScriptRunner(
        new ScriptRequestProcessor(this, aRequest));
    } else {
      MaybeMoveToLoadedList(aRequest);
      ProcessPendingRequests();
    }
  }

  if (aRequest->mWasCompiledOMT) {
    mDocument->UnblockOnload(false);
  }
}

JS::Value
ScriptLoader::FindFirstParseError(ModuleLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest);

  ModuleScript* moduleScript = aRequest->mModuleScript;
  MOZ_ASSERT(moduleScript);

  if (moduleScript->HasParseError()) {
    return moduleScript->ParseError();
  }

  for (ModuleLoadRequest* childRequest : aRequest->mImports) {
    JS::Value error = FindFirstParseError(childRequest);
    if (!error.isUndefined()) {
      return error;
    }
  }

  return JS::UndefinedValue();
}

bool
ScriptLoader::InstantiateModuleTree(ModuleLoadRequest* aRequest)
{
  // Instantiate a top-level module and record any error.

  MOZ_ASSERT(aRequest);
  MOZ_ASSERT(aRequest->IsTopLevel());

  LOG(("ScriptLoadRequest (%p): Instantiate module tree", aRequest));

  ModuleScript* moduleScript = aRequest->mModuleScript;
  MOZ_ASSERT(moduleScript);

  JS::Value parseError = FindFirstParseError(aRequest);
  if (!parseError.isUndefined()) {
    moduleScript->SetErrorToRethrow(parseError);
    LOG(("ScriptLoadRequest (%p):   found parse error", aRequest));
    return true;
  }

  MOZ_ASSERT(moduleScript->Script());

  nsAutoMicroTask mt;
  AutoJSAPI jsapi;
  if (NS_WARN_IF(!jsapi.Init(JS::GetScriptGlobal(moduleScript->Script())))) {
    return false;
  }

  EnsureModuleResolveHook(jsapi.cx());

  JS::Rooted<JSScript*> script(jsapi.cx(), moduleScript->Script());
  bool ok = NS_SUCCEEDED(nsJSUtils::ModuleInstantiate(jsapi.cx(), script));

  if (!ok) {
    LOG(("ScriptLoadRequest (%p): Instantiate failed", aRequest));
    MOZ_ASSERT(jsapi.HasException());
    JS::RootedValue exception(jsapi.cx());
    if (!jsapi.StealException(&exception)) {
      return false;
    }
    MOZ_ASSERT(!exception.isUndefined());
    moduleScript->SetErrorToRethrow(exception);
  }

  return true;
}

nsresult
ScriptLoader::AssociateSourceElementsForModuleTree(JSContext* aCx,
                                                   ModuleLoadRequest* aRequest)
{
  // Preloading can cause JS scripts to be compiled before DOM script element
  // nodes have been created. This method ensures compiled scripts are
  // associated with DOM element nodes before execution.

  MOZ_ASSERT(aRequest);

  ModuleScript* moduleScript = aRequest->mModuleScript;
  if (moduleScript->SourceElementAssociated()) {
    return NS_OK;
  }

  for (ModuleLoadRequest* childRequest : aRequest->mImports) {
    nsresult rv = AssociateSourceElementsForModuleTree(aCx, childRequest);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  JS::Rooted<JSScript*> script(aCx, moduleScript->Script());
  MOZ_ASSERT(script);

  nsresult rv = nsJSUtils::InitModuleSourceElement(aCx, script, aRequest->Element());
  NS_ENSURE_SUCCESS(rv, rv);
  moduleScript->SetSourceElementAssociated();

  // The script is now ready to be exposed to the debugger.
  JS::ExposeScriptToDebugger(aCx, script);

  return NS_OK;
}

nsresult
ScriptLoader::RestartLoad(ScriptLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest->IsBytecode());
  aRequest->mScriptBytecode.clearAndFree();
  TRACE_FOR_TEST(aRequest->Element(), "scriptloader_fallback");

  // Start a new channel from which we explicitly request to stream the source
  // instead of the bytecode.
  aRequest->mProgress = ScriptLoadRequest::Progress::eLoading_Source;
  nsresult rv = StartLoad(aRequest);
  if (NS_FAILED(rv)) {
    return rv;
  }

  // Close the current channel and this ScriptLoadHandler as we created a new
  // one for the same request.
  return NS_BINDING_RETARGETED;
}

nsresult
ScriptLoader::StartLoad(ScriptLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest->IsLoading());
  NS_ENSURE_TRUE(mDocument, NS_ERROR_NULL_POINTER);
  aRequest->SetUnknownDataType();

  // If this document is sandboxed without 'allow-scripts', abort.
  if (mDocument->HasScriptsBlockedBySandbox()) {
    return NS_OK;
  }

  if (LOG_ENABLED()) {
    nsAutoCString url;
    aRequest->mURI->GetAsciiSpec(url);
    LOG(("ScriptLoadRequest (%p): Start Load (url = %s)", aRequest, url.get()));
  }

  if (aRequest->IsModuleRequest()) {
    // Check whether the module has been fetched or is currently being fetched,
    // and if so wait for it rather than starting a new fetch.
    ModuleLoadRequest* request = aRequest->AsModuleRequest();
    if (ModuleMapContainsURL(request->mURI)) {
      LOG(("ScriptLoadRequest (%p): Waiting for module fetch", aRequest));
      WaitForModuleFetch(request->mURI)
        ->Then(GetMainThreadSerialEventTarget(), __func__, request,
               &ModuleLoadRequest::ModuleLoaded,
               &ModuleLoadRequest::LoadFailed);
      return NS_OK;
    }
  }

  nsContentPolicyType contentPolicyType = aRequest->IsPreload()
                                          ? nsIContentPolicy::TYPE_INTERNAL_SCRIPT_PRELOAD
                                          : nsIContentPolicy::TYPE_INTERNAL_SCRIPT;
  nsCOMPtr<nsINode> context;
  if (aRequest->Element()) {
    context = do_QueryInterface(aRequest->Element());
  }
  else {
    context = mDocument;
  }

  nsCOMPtr<nsILoadGroup> loadGroup = mDocument->GetDocumentLoadGroup();
  nsCOMPtr<nsPIDOMWindowOuter> window = mDocument->GetWindow();
  NS_ENSURE_TRUE(window, NS_ERROR_NULL_POINTER);
  nsIDocShell* docshell = window->GetDocShell();
  nsCOMPtr<nsIInterfaceRequestor> prompter(do_QueryInterface(docshell));

  nsSecurityFlags securityFlags;
  if (aRequest->IsModuleRequest()) {
    // According to the spec, module scripts have different behaviour to classic
    // scripts and always use CORS.
    securityFlags = nsILoadInfo::SEC_REQUIRE_CORS_DATA_INHERITS;
    if (aRequest->CORSMode() == CORS_NONE) {
      securityFlags |= nsILoadInfo::SEC_COOKIES_OMIT;
    } else if (aRequest->CORSMode() == CORS_ANONYMOUS) {
      securityFlags |= nsILoadInfo::SEC_COOKIES_SAME_ORIGIN;
    } else {
      MOZ_ASSERT(aRequest->CORSMode() == CORS_USE_CREDENTIALS);
      securityFlags |= nsILoadInfo::SEC_COOKIES_INCLUDE;
    }
  } else {
    securityFlags = aRequest->CORSMode() == CORS_NONE
      ? nsILoadInfo::SEC_ALLOW_CROSS_ORIGIN_DATA_IS_NULL
      : nsILoadInfo::SEC_REQUIRE_CORS_DATA_INHERITS;
    if (aRequest->CORSMode() == CORS_ANONYMOUS) {
      securityFlags |= nsILoadInfo::SEC_COOKIES_SAME_ORIGIN;
    } else if (aRequest->CORSMode() == CORS_USE_CREDENTIALS) {
      securityFlags |= nsILoadInfo::SEC_COOKIES_INCLUDE;
    }
  }
  securityFlags |= nsILoadInfo::SEC_ALLOW_CHROME;

  nsCOMPtr<nsIChannel> channel;
  nsresult rv = NS_NewChannelWithTriggeringPrincipal(
      getter_AddRefs(channel),
      aRequest->mURI,
      context,
      aRequest->TriggeringPrincipal(),
      securityFlags,
      contentPolicyType,
      nullptr, // aPerformanceStorage
      loadGroup,
      prompter,
      nsIRequest::LOAD_NORMAL |
      nsIChannel::LOAD_CLASSIFY_URI);

  NS_ENSURE_SUCCESS(rv, rv);

  // To avoid decoding issues, the build-id is part of the JSBytecodeMimeType
  // constant.
  aRequest->mCacheInfo = nullptr;
  nsCOMPtr<nsICacheInfoChannel> cic(do_QueryInterface(channel));
  if (cic && nsContentUtils::IsBytecodeCacheEnabled()) {
    if (!aRequest->IsLoadingSource()) {
      // Inform the HTTP cache that we prefer to have information coming from the
      // bytecode cache instead of the sources, if such entry is already registered.
      LOG(("ScriptLoadRequest (%p): Maybe request bytecode", aRequest));
      cic->PreferAlternativeDataType(nsContentUtils::JSBytecodeMimeType());
    } else {
      // If we are explicitly loading from the sources, such as after a
      // restarted request, we might still want to save the bytecode after.
      //
      // The following tell the cache to look for an alternative data type which
      // does not exist, such that we can later save the bytecode with a
      // different alternative data type.
      LOG(("ScriptLoadRequest (%p): Request saving bytecode later", aRequest));
      cic->PreferAlternativeDataType(kNullMimeType);
    }
  }

  LOG(("ScriptLoadRequest (%p): mode=%u tracking=%d",
       aRequest, unsigned(aRequest->mScriptMode), aRequest->IsTracking()));

  nsCOMPtr<nsIClassOfService> cos(do_QueryInterface(channel));
  if (cos) {
    if (aRequest->mScriptFromHead && aRequest->IsBlockingScript()) {
      // synchronous head scripts block loading of most other non js/css
      // content such as images, Leader implicitely disallows tailing
      cos->AddClassFlags(nsIClassOfService::Leader);
    } else if (aRequest->IsDeferredScript() &&
               !nsContentUtils::IsTailingEnabled()) {
      // Bug 1395525 and the !nsContentUtils::IsTailingEnabled() bit:
      // We want to make sure that turing tailing off by the pref makes
      // the browser behave exactly the same way as before landing
      // the tailing patch.

      // head/body deferred scripts are blocked by leaders but are not
      // allowed tailing because they block DOMContentLoaded
      cos->AddClassFlags(nsIClassOfService::TailForbidden);
    } else {
      // other scripts (=body sync or head/body async) are neither blocked
      // nor prioritized
      cos->AddClassFlags(nsIClassOfService::Unblocked);

      if (aRequest->IsAsyncScript()) {
        // async scripts are allowed tailing, since those and only those
        // don't block DOMContentLoaded; this flag doesn't enforce tailing,
        // just overweights the Unblocked flag when the channel is found
        // to be a thrird-party tracker and thus set the Tail flag to engage
        // tailing.
        cos->AddClassFlags(nsIClassOfService::TailAllowed);
      }
    }
  }

  nsCOMPtr<nsIHttpChannel> httpChannel(do_QueryInterface(channel));
  if (httpChannel) {
    // HTTP content negotation has little value in this context.
    nsAutoCString acceptTypes("*/*");
    if (BinASTEncodingEnabled() && aRequest->ShouldAcceptBinASTEncoding()) {
      acceptTypes = APPLICATION_JAVASCRIPT_BINAST ", */*";
    }
    rv = httpChannel->SetRequestHeader(NS_LITERAL_CSTRING("Accept"),
                                       acceptTypes, false);
    MOZ_ASSERT(NS_SUCCEEDED(rv));

    rv = httpChannel->SetReferrerWithPolicy(aRequest->mReferrer,
                                            aRequest->ReferrerPolicy());
    MOZ_ASSERT(NS_SUCCEEDED(rv));

    nsCOMPtr<nsIHttpChannelInternal> internalChannel(do_QueryInterface(httpChannel));
    if (internalChannel) {
      rv = internalChannel->SetIntegrityMetadata(aRequest->mIntegrity.GetIntegrityString());
      MOZ_ASSERT(NS_SUCCEEDED(rv));
    }
  }

  mozilla::net::PredictorLearn(aRequest->mURI, mDocument->GetDocumentURI(),
                               nsINetworkPredictor::LEARN_LOAD_SUBRESOURCE,
                               mDocument->NodePrincipal()->OriginAttributesRef());

  // Set the initiator type
  nsCOMPtr<nsITimedChannel> timedChannel(do_QueryInterface(httpChannel));
  if (timedChannel) {
    timedChannel->SetInitiatorType(NS_LITERAL_STRING("script"));
  }

  nsAutoPtr<mozilla::dom::SRICheckDataVerifier> sriDataVerifier;
  if (!aRequest->mIntegrity.IsEmpty()) {
    nsAutoCString sourceUri;
    if (mDocument->GetDocumentURI()) {
      mDocument->GetDocumentURI()->GetAsciiSpec(sourceUri);
    }
    sriDataVerifier = new SRICheckDataVerifier(aRequest->mIntegrity, sourceUri,
                                               mReporter);
  }

  RefPtr<ScriptLoadHandler> handler =
      new ScriptLoadHandler(this, aRequest, sriDataVerifier.forget());

  nsCOMPtr<nsIIncrementalStreamLoader> loader;
  rv = NS_NewIncrementalStreamLoader(getter_AddRefs(loader), handler);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = channel->AsyncOpen2(loader);
  NS_ENSURE_SUCCESS(rv, rv);

  if (aRequest->IsModuleRequest()) {
    // We successfully started fetching a module so put its URL in the module
    // map and mark it as fetching.
    SetModuleFetchStarted(aRequest->AsModuleRequest());
    LOG(("ScriptLoadRequest (%p): Start fetching module", aRequest));
  }

  return NS_OK;
}

bool
ScriptLoader::PreloadURIComparator::Equals(const PreloadInfo& aPi,
                                           nsIURI* const& aURI) const
{
  bool same;
  return NS_SUCCEEDED(aPi.mRequest->mURI->Equals(aURI, &same)) &&
         same;
}

static bool
CSPAllowsInlineScript(nsIScriptElement* aElement, nsIDocument* aDocument)
{
  nsCOMPtr<nsIContentSecurityPolicy> csp;
  // Note: For imports NodePrincipal and the principal of the master are
  // the same.
  nsresult rv = aDocument->NodePrincipal()->GetCsp(getter_AddRefs(csp));
  NS_ENSURE_SUCCESS(rv, false);

  if (!csp) {
    // no CSP --> allow
    return true;
  }

  // query the nonce
  nsCOMPtr<Element> scriptContent = do_QueryInterface(aElement);
  nsAutoString nonce;
  scriptContent->GetAttr(kNameSpaceID_None, nsGkAtoms::nonce, nonce);
  bool parserCreated = aElement->GetParserCreated() != mozilla::dom::NOT_FROM_PARSER;

  bool allowInlineScript = false;
  rv = csp->GetAllowsInline(nsIContentPolicy::TYPE_SCRIPT,
                            nonce, parserCreated, scriptContent, EmptyString(),
                            aElement->GetScriptLineNumber(),
                            aElement->GetScriptColumnNumber(),
                            &allowInlineScript);
  return allowInlineScript;
}

ScriptLoadRequest*
ScriptLoader::CreateLoadRequest(ScriptKind aKind,
                                nsIURI* aURI,
                                nsIScriptElement* aElement,
                                nsIPrincipal* aTriggeringPrincipal,
                                CORSMode aCORSMode,
                                const SRIMetadata& aIntegrity,
                                mozilla::net::ReferrerPolicy aReferrerPolicy)
{
  nsIURI* referrer = mDocument->GetDocumentURI();
  ScriptFetchOptions* fetchOptions =
    new ScriptFetchOptions(aCORSMode, aReferrerPolicy, aElement, aTriggeringPrincipal);

  if (aKind == ScriptKind::eClassic) {
    return new ScriptLoadRequest(aKind, aURI, fetchOptions, aIntegrity, referrer);
  }

  MOZ_ASSERT(aKind == ScriptKind::eModule);
  return new ModuleLoadRequest(aURI, fetchOptions, aIntegrity, referrer, this);
}

bool
ScriptLoader::ProcessScriptElement(nsIScriptElement* aElement)
{
  // We need a document to evaluate scripts.
  NS_ENSURE_TRUE(mDocument, false);

  // Check to see if scripts has been turned off.
  if (!mEnabled || !mDocument->IsScriptEnabled()) {
    return false;
  }

  NS_ASSERTION(!aElement->IsMalformed(), "Executing malformed script");

  nsAutoCString url;
  nsCOMPtr<nsIURI> scriptURI = aElement->GetScriptURI();
  if (scriptURI) {
    scriptURI->GetAsciiSpec(url);
  }
  AUTO_PROFILER_LABEL_DYNAMIC_NSCSTRING(
    "ScriptLoader::ProcessScriptElement", JS, url);

  nsCOMPtr<nsIContent> scriptContent = do_QueryInterface(aElement);

  nsAutoString type;
  bool hasType = aElement->GetScriptType(type);

  ScriptKind scriptKind =
    aElement->GetScriptIsModule() ? ScriptKind::eModule : ScriptKind::eClassic;

  // Step 13. Check that the script is not an eventhandler
  if (IsScriptEventHandler(scriptKind, scriptContent)) {
    return false;
  }

  // For classic scripts, check the type attribute to determine language and
  // version. If type exists, it trumps the deprecated 'language='
  if (scriptKind == ScriptKind::eClassic) {
    if (!type.IsEmpty()) {
      NS_ENSURE_TRUE(nsContentUtils::IsJavascriptMIMEType(type), false);
    } else if (!hasType) {
      // no 'type=' element
      // "language" is a deprecated attribute of HTML, so we check it only for
      // HTML script elements.
      if (scriptContent->IsHTMLElement()) {
        nsAutoString language;
        scriptContent->AsElement()->GetAttr(kNameSpaceID_None,
                                            nsGkAtoms::language,
                                            language);
        if (!language.IsEmpty()) {
          if (!nsContentUtils::IsJavaScriptLanguage(language)) {
            return false;
          }
        }
      }
    }
  }

  // "In modern user agents that support module scripts, the script element with
  // the nomodule attribute will be ignored".
  // "The nomodule attribute must not be specified on module scripts (and will
  // be ignored if it is)."
  if (mDocument->ModuleScriptsEnabled() &&
      scriptKind == ScriptKind::eClassic &&
      scriptContent->IsHTMLElement() &&
      scriptContent->AsElement()->HasAttr(kNameSpaceID_None, nsGkAtoms::nomodule)) {
    return false;
  }

  // Step 15. and later in the HTML5 spec
  if (aElement->GetScriptExternal()) {
    return ProcessExternalScript(aElement, scriptKind, type, scriptContent);
  }

  return ProcessInlineScript(aElement, scriptKind);
}

bool
ScriptLoader::ProcessExternalScript(nsIScriptElement* aElement,
                                    ScriptKind aScriptKind,
                                    nsAutoString aTypeAttr,
                                    nsIContent* aScriptContent)
{
  LOG(("ScriptLoader (%p): Process external script for element %p",
       this, aElement));

  nsCOMPtr<nsIURI> scriptURI = aElement->GetScriptURI();
  if (!scriptURI) {
    // Asynchronously report the failure to create a URI object
    NS_DispatchToCurrentThread(
      NewRunnableMethod("nsIScriptElement::FireErrorEvent",
                        aElement,
                        &nsIScriptElement::FireErrorEvent));
    return false;
  }

  RefPtr<ScriptLoadRequest> request = LookupPreloadRequest(aElement, aScriptKind);

  if (request && NS_FAILED(CheckContentPolicy(mDocument, aElement, request->mURI,
                                              aTypeAttr, false))) {
    LOG(("ScriptLoader (%p): content policy check failed for preload", this));

    // Probably plans have changed; even though the preload was allowed seems
    // like the actual load is not; let's cancel the preload request.
    request->Cancel();
    AccumulateCategorical(LABELS_DOM_SCRIPT_PRELOAD_RESULT::RejectedByPolicy);
    return false;
  }

  if (request) {
    // Use the preload request.

    LOG(("ScriptLoadRequest (%p): Using preload request", request.get()));

    // It's possible these attributes changed since we started the preload so
    // update them here.
    request->SetScriptMode(aElement->GetScriptDeferred(),
                           aElement->GetScriptAsync());

    AccumulateCategorical(LABELS_DOM_SCRIPT_PRELOAD_RESULT::Used);
  } else {
    // No usable preload found.

    SRIMetadata sriMetadata;
    {
      nsAutoString integrity;
      aScriptContent->AsElement()->GetAttr(kNameSpaceID_None,
                                          nsGkAtoms::integrity,
                                          integrity);
      GetSRIMetadata(integrity, &sriMetadata);
    }

    nsCOMPtr<nsIPrincipal> principal = aElement->GetScriptURITriggeringPrincipal();
    if (!principal) {
      principal = aScriptContent->NodePrincipal();
    }

    CORSMode ourCORSMode = aElement->GetCORSMode();
    mozilla::net::ReferrerPolicy ourRefPolicy = mDocument->GetReferrerPolicy();
    request = CreateLoadRequest(aScriptKind, scriptURI, aElement, principal,
                                ourCORSMode, sriMetadata, ourRefPolicy);
    request->mIsInline = false;
    request->SetScriptMode(aElement->GetScriptDeferred(),
                           aElement->GetScriptAsync());
    // keep request->mScriptFromHead to false so we don't treat non preloaded
    // scripts as blockers for full page load. See bug 792438.

    LOG(("ScriptLoadRequest (%p): Created request for external script",
         request.get()));

    nsresult rv = StartLoad(request);
    if (NS_FAILED(rv)) {
      ReportErrorToConsole(request, rv);

      // Asynchronously report the load failure
      nsCOMPtr<nsIRunnable> runnable =
        NewRunnableMethod("nsIScriptElement::FireErrorEvent",
                          aElement,
                          &nsIScriptElement::FireErrorEvent);
      if (mDocument) {
        mDocument->Dispatch(TaskCategory::Other, runnable.forget());
      } else {
        NS_DispatchToCurrentThread(runnable);
      }
      return false;
    }
  }

  // We should still be in loading stage of script unless we're loading a
  // module.
  NS_ASSERTION(!request->InCompilingStage() || request->IsModuleRequest(),
               "Request should not yet be in compiling stage.");

  if (request->IsAsyncScript()) {
    AddAsyncRequest(request);
    if (request->IsReadyToRun()) {
      // The script is available already. Run it ASAP when the event
      // loop gets a chance to spin.

      // KVKV TODO: Instead of processing immediately, try off-thread-parsing
      // it and only schedule a pending ProcessRequest if that fails.
      ProcessPendingRequestsAsync();
    }
    return false;
  }
  if (!aElement->GetParserCreated()) {
    // Violate the HTML5 spec in order to make LABjs and the "order" plug-in
    // for RequireJS work with their Gecko-sniffed code path. See
    // http://lists.w3.org/Archives/Public/public-html/2010Oct/0088.html
    request->mIsNonAsyncScriptInserted = true;
    mNonAsyncExternalScriptInsertedRequests.AppendElement(request);
    if (request->IsReadyToRun()) {
      // The script is available already. Run it ASAP when the event
      // loop gets a chance to spin.
      ProcessPendingRequestsAsync();
    }
    return false;
  }
  // we now have a parser-inserted request that may or may not be still
  // loading
  if (request->IsDeferredScript()) {
    // We don't want to run this yet.
    // If we come here, the script is a parser-created script and it has
    // the defer attribute but not the async attribute. Since a
    // a parser-inserted script is being run, we came here by the parser
    // running the script, which means the parser is still alive and the
    // parse is ongoing.
    NS_ASSERTION(mDocument->GetCurrentContentSink() ||
                 aElement->GetParserCreated() == FROM_PARSER_XSLT,
        "Non-XSLT Defer script on a document without an active parser; bug 592366.");
    AddDeferRequest(request);
    return false;
  }

  if (aElement->GetParserCreated() == FROM_PARSER_XSLT) {
    // Need to maintain order for XSLT-inserted scripts
    NS_ASSERTION(!mParserBlockingRequest,
        "Parser-blocking scripts and XSLT scripts in the same doc!");
    request->mIsXSLT = true;
    mXSLTRequests.AppendElement(request);
    if (request->IsReadyToRun()) {
      // The script is available already. Run it ASAP when the event
      // loop gets a chance to spin.
      ProcessPendingRequestsAsync();
    }
    return true;
  }

  if (request->IsReadyToRun() && ReadyToExecuteParserBlockingScripts()) {
    // The request has already been loaded and there are no pending style
    // sheets. If the script comes from the network stream, cheat for
    // performance reasons and avoid a trip through the event loop.
    if (aElement->GetParserCreated() == FROM_PARSER_NETWORK) {
      return ProcessRequest(request) == NS_ERROR_HTMLPARSER_BLOCK;
    }
    // Otherwise, we've got a document.written script, make a trip through
    // the event loop to hide the preload effects from the scripts on the
    // Web page.
    NS_ASSERTION(!mParserBlockingRequest,
        "There can be only one parser-blocking script at a time");
    NS_ASSERTION(mXSLTRequests.isEmpty(),
        "Parser-blocking scripts and XSLT scripts in the same doc!");
    mParserBlockingRequest = request;
    ProcessPendingRequestsAsync();
    return true;
  }

  // The script hasn't loaded yet or there's a style sheet blocking it.
  // The script will be run when it loads or the style sheet loads.
  NS_ASSERTION(!mParserBlockingRequest,
      "There can be only one parser-blocking script at a time");
  NS_ASSERTION(mXSLTRequests.isEmpty(),
      "Parser-blocking scripts and XSLT scripts in the same doc!");
  mParserBlockingRequest = request;
  return true;
}

bool
ScriptLoader::ProcessInlineScript(nsIScriptElement* aElement,
                                  ScriptKind aScriptKind)
{
  // Is this document sandboxed without 'allow-scripts'?
  if (mDocument->HasScriptsBlockedBySandbox()) {
    return false;
  }

  // Does CSP allow this inline script to run?
  if (!CSPAllowsInlineScript(aElement, mDocument)) {
    return false;
  }

  // Inline classic scripts ignore their CORS mode and are always CORS_NONE.
  CORSMode corsMode = CORS_NONE;
  if (aScriptKind == ScriptKind::eModule) {
    corsMode = aElement->GetCORSMode();
  }

  RefPtr<ScriptLoadRequest> request =
    CreateLoadRequest(aScriptKind, mDocument->GetDocumentURI(), aElement,
                      mDocument->NodePrincipal(),
                      corsMode,
                      SRIMetadata(), // SRI doesn't apply
                      mDocument->GetReferrerPolicy());
  request->mIsInline = true;
  request->mLineNo = aElement->GetScriptLineNumber();
  request->mProgress = ScriptLoadRequest::Progress::eLoading_Source;
  request->SetTextSource();
  TRACE_FOR_TEST_BOOL(request->Element(), "scriptloader_load_source");
  CollectScriptTelemetry(request);

  // Only the 'async' attribute is heeded on an inline module script and
  // inline classic scripts ignore both these attributes.
  MOZ_ASSERT(!aElement->GetScriptDeferred());
  MOZ_ASSERT_IF(!request->IsModuleRequest(), !aElement->GetScriptAsync());
  request->SetScriptMode(false, aElement->GetScriptAsync());

  LOG(("ScriptLoadRequest (%p): Created request for inline script",
       request.get()));

  if (request->IsModuleRequest()) {
    ModuleLoadRequest* modReq = request->AsModuleRequest();
    modReq->mBaseURL = mDocument->GetDocBaseURI();

    if (aElement->GetParserCreated() != NOT_FROM_PARSER) {
      if (aElement->GetScriptAsync()) {
        AddAsyncRequest(modReq);
      } else {
        AddDeferRequest(modReq);
      }
    }

    nsresult rv = ProcessFetchedModuleSource(modReq);
    if (NS_FAILED(rv)) {
      ReportErrorToConsole(modReq, rv);
      HandleLoadError(modReq, rv);
    }

    return false;
  }
  request->mProgress = ScriptLoadRequest::Progress::eReady;
  if (aElement->GetParserCreated() == FROM_PARSER_XSLT &&
      (!ReadyToExecuteParserBlockingScripts() || !mXSLTRequests.isEmpty())) {
    // Need to maintain order for XSLT-inserted scripts
    NS_ASSERTION(!mParserBlockingRequest,
        "Parser-blocking scripts and XSLT scripts in the same doc!");
    mXSLTRequests.AppendElement(request);
    return true;
  }
  if (aElement->GetParserCreated() == NOT_FROM_PARSER) {
    NS_ASSERTION(!nsContentUtils::IsSafeToRunScript(),
        "A script-inserted script is inserted without an update batch?");
    nsContentUtils::AddScriptRunner(new ScriptRequestProcessor(this,
                                                               request));
    return false;
  }
  if (aElement->GetParserCreated() == FROM_PARSER_NETWORK &&
      !ReadyToExecuteParserBlockingScripts()) {
    NS_ASSERTION(!mParserBlockingRequest,
        "There can be only one parser-blocking script at a time");
    mParserBlockingRequest = request;
    NS_ASSERTION(mXSLTRequests.isEmpty(),
        "Parser-blocking scripts and XSLT scripts in the same doc!");
    return true;
  }
  // We now have a document.written inline script or we have an inline script
  // from the network but there is no style sheet that is blocking scripts.
  // Don't check for style sheets blocking scripts in the document.write
  // case to avoid style sheet network activity affecting when
  // document.write returns. It's not really necessary to do this if
  // there's no document.write currently on the call stack. However,
  // this way matches IE more closely than checking if document.write
  // is on the call stack.
  NS_ASSERTION(nsContentUtils::IsSafeToRunScript(),
      "Not safe to run a parser-inserted script?");
  return ProcessRequest(request) == NS_ERROR_HTMLPARSER_BLOCK;
}

ScriptLoadRequest*
ScriptLoader::LookupPreloadRequest(nsIScriptElement* aElement,
                                   ScriptKind aScriptKind)
{
  MOZ_ASSERT(aElement);

  nsTArray<PreloadInfo>::index_type i =
    mPreloads.IndexOf(aElement->GetScriptURI(), 0, PreloadURIComparator());
  if (i == nsTArray<PreloadInfo>::NoIndex) {
    return nullptr;
  }

  // Found preloaded request. Note that a script-inserted script can steal a
  // preload!
  RefPtr<ScriptLoadRequest> request = mPreloads[i].mRequest;
  request->SetElement(aElement);
  nsString preloadCharset(mPreloads[i].mCharset);
  mPreloads.RemoveElementAt(i);

  // Double-check that the charset the preload used is the same as the charset
  // we have now.
  nsAutoString elementCharset;
  aElement->GetScriptCharset(elementCharset);
  if (!elementCharset.Equals(preloadCharset) ||
      aElement->GetCORSMode() != request->CORSMode() ||
      mDocument->GetReferrerPolicy() != request->ReferrerPolicy() ||
      aScriptKind != request->mKind) {
    // Drop the preload.
    request->Cancel();
    AccumulateCategorical(LABELS_DOM_SCRIPT_PRELOAD_RESULT::RequestMismatch);
    return nullptr;
  }

  return request;
}

void
ScriptLoader::GetSRIMetadata(const nsAString& aIntegrityAttr,
                             SRIMetadata *aMetadataOut)
{
  MOZ_ASSERT(aMetadataOut->IsEmpty());

  if (aIntegrityAttr.IsEmpty()) {
    return;
  }

  MOZ_LOG(SRILogHelper::GetSriLog(), mozilla::LogLevel::Debug,
          ("ScriptLoader::GetSRIMetadata, integrity=%s",
           NS_ConvertUTF16toUTF8(aIntegrityAttr).get()));

  nsAutoCString sourceUri;
  if (mDocument->GetDocumentURI()) {
    mDocument->GetDocumentURI()->GetAsciiSpec(sourceUri);
  }
  SRICheck::IntegrityMetadata(aIntegrityAttr, sourceUri, mReporter,
                              aMetadataOut);
}

namespace {

class NotifyOffThreadScriptLoadCompletedRunnable : public Runnable
{
  RefPtr<ScriptLoadRequest> mRequest;
  RefPtr<ScriptLoader> mLoader;
  RefPtr<DocGroup> mDocGroup;
  JS::OffThreadToken* mToken;

public:
  NotifyOffThreadScriptLoadCompletedRunnable(ScriptLoadRequest* aRequest,
                                             ScriptLoader* aLoader)
    : Runnable("dom::NotifyOffThreadScriptLoadCompletedRunnable")
    , mRequest(aRequest)
    , mLoader(aLoader)
    , mDocGroup(aLoader->GetDocGroup())
    , mToken(nullptr)
  {
    MOZ_ASSERT(NS_IsMainThread());
  }

  virtual ~NotifyOffThreadScriptLoadCompletedRunnable();

  void SetToken(JS::OffThreadToken* aToken) {
    MOZ_ASSERT(aToken && !mToken);
    mToken = aToken;
  }

  static void Dispatch(already_AddRefed<NotifyOffThreadScriptLoadCompletedRunnable>&& aSelf) {
    RefPtr<NotifyOffThreadScriptLoadCompletedRunnable> self = aSelf;
    RefPtr<DocGroup> docGroup = self->mDocGroup;
    docGroup->Dispatch(TaskCategory::Other, self.forget());
  }

  NS_DECL_NSIRUNNABLE
};

} /* anonymous namespace */

nsresult
ScriptLoader::ProcessOffThreadRequest(ScriptLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest->mProgress == ScriptLoadRequest::Progress::eCompiling);
  MOZ_ASSERT(!aRequest->mWasCompiledOMT);

  aRequest->mWasCompiledOMT = true;

  if (aRequest->IsModuleRequest()) {
    MOZ_ASSERT(aRequest->mOffThreadToken);
    ModuleLoadRequest* request = aRequest->AsModuleRequest();
    return ProcessFetchedModuleSource(request);
  }

  aRequest->SetReady();

  if (aRequest == mParserBlockingRequest) {
    if (!ReadyToExecuteParserBlockingScripts()) {
      // If not ready to execute scripts, schedule an async call to
      // ProcessPendingRequests to handle it.
      ProcessPendingRequestsAsync();
      return NS_OK;
    }

    // Same logic as in top of ProcessPendingRequests.
    mParserBlockingRequest = nullptr;
    UnblockParser(aRequest);
    ProcessRequest(aRequest);
    mDocument->UnblockOnload(false);
    ContinueParserAsync(aRequest);
    return NS_OK;
  }

  nsresult rv = ProcessRequest(aRequest);
  mDocument->UnblockOnload(false);
  return rv;
}

NotifyOffThreadScriptLoadCompletedRunnable::~NotifyOffThreadScriptLoadCompletedRunnable()
{
  if (MOZ_UNLIKELY(mRequest || mLoader) && !NS_IsMainThread()) {
    NS_ReleaseOnMainThreadSystemGroup("NotifyOffThreadScriptLoadCompletedRunnable::mRequest",
                                      mRequest.forget());
    NS_ReleaseOnMainThreadSystemGroup("NotifyOffThreadScriptLoadCompletedRunnable::mLoader",
                                      mLoader.forget());
  }
}

NS_IMETHODIMP
NotifyOffThreadScriptLoadCompletedRunnable::Run()
{
  MOZ_ASSERT(NS_IsMainThread());

  // We want these to be dropped on the main thread, once we return from this
  // function.
  RefPtr<ScriptLoadRequest> request = mRequest.forget();
  RefPtr<ScriptLoader> loader = mLoader.forget();

  request->mOffThreadToken = mToken;
  nsresult rv = loader->ProcessOffThreadRequest(request);

  return rv;
}

static void
OffThreadScriptLoaderCallback(JS::OffThreadToken* aToken, void* aCallbackData)
{
  RefPtr<NotifyOffThreadScriptLoadCompletedRunnable> aRunnable =
    dont_AddRef(static_cast<NotifyOffThreadScriptLoadCompletedRunnable*>(aCallbackData));
  aRunnable->SetToken(aToken);
  NotifyOffThreadScriptLoadCompletedRunnable::Dispatch(aRunnable.forget());
}

nsresult
ScriptLoader::AttemptAsyncScriptCompile(ScriptLoadRequest* aRequest,
                                        bool* aCouldCompileOut)
{
  MOZ_ASSERT_IF(!aRequest->IsModuleRequest(), aRequest->IsReadyToRun());
  MOZ_ASSERT(!aRequest->mWasCompiledOMT);
  MOZ_ASSERT(aCouldCompileOut && !*aCouldCompileOut);

  // Don't off-thread compile inline scripts.
  if (aRequest->mIsInline) {
    return NS_OK;
  }

  nsCOMPtr<nsIScriptGlobalObject> globalObject = GetScriptGlobalObject();
  if (!globalObject) {
    return NS_ERROR_FAILURE;
  }

  AutoJSAPI jsapi;
  if (!jsapi.Init(globalObject)) {
    return NS_ERROR_FAILURE;
  }

  JSContext* cx = jsapi.cx();
  JS::Rooted<JSObject*> global(cx, globalObject->GetGlobalJSObject());
  JS::CompileOptions options(cx);

  nsresult rv = FillCompileOptionsForRequest(jsapi, aRequest, global, &options);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }

  if (aRequest->IsTextSource()) {
    if (!JS::CanCompileOffThread(cx, options, aRequest->ScriptText().length())) {
      return NS_OK;
    }
#ifdef JS_BUILD_BINAST
  } else if (aRequest->IsBinASTSource()) {
    if (!JS::CanDecodeBinASTOffThread(cx, options, aRequest->ScriptBinASTData().length())) {
      return NS_OK;
    }
#endif
  } else {
    MOZ_ASSERT(aRequest->IsBytecode());
    size_t length = aRequest->mScriptBytecode.length() - aRequest->mBytecodeOffset;
    if (!JS::CanDecodeOffThread(cx, options, length)) {
      return NS_OK;
    }
  }

  RefPtr<NotifyOffThreadScriptLoadCompletedRunnable> runnable =
    new NotifyOffThreadScriptLoadCompletedRunnable(aRequest, this);

  if (aRequest->IsModuleRequest()) {
    MOZ_ASSERT(aRequest->IsTextSource());
    auto srcBuf = GetScriptSource(cx, aRequest);
    if (!srcBuf || !JS::CompileOffThreadModule(cx, options,
                                               *srcBuf,
                                               OffThreadScriptLoaderCallback,
                                               static_cast<void*>(runnable))) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
  } else if (aRequest->IsBytecode()) {
    if (!JS::DecodeOffThreadScript(cx, options,
                                   aRequest->mScriptBytecode,
                                   aRequest->mBytecodeOffset,
                                   OffThreadScriptLoaderCallback,
                                   static_cast<void*>(runnable))) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
#ifdef JS_BUILD_BINAST
  } else if (aRequest->IsBinASTSource()) {
    MOZ_ASSERT(aRequest->IsSource());
    if (!JS::DecodeBinASTOffThread(cx, options,
                                   aRequest->ScriptBinASTData().begin(),
                                   aRequest->ScriptBinASTData().length(),
                                   OffThreadScriptLoaderCallback,
                                   static_cast<void*>(runnable))) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
#endif
  } else {
    MOZ_ASSERT(aRequest->IsTextSource());
    auto srcBuf = GetScriptSource(cx, aRequest);
    if (!srcBuf || !JS::CompileOffThread(cx, options,
                                         *srcBuf,
                                         OffThreadScriptLoaderCallback,
                                         static_cast<void*>(runnable))) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
  }

  mDocument->BlockOnload();

  // Once the compilation is finished, an event would be added to the event loop
  // to call ScriptLoader::ProcessOffThreadRequest with the same request.
  aRequest->mProgress = ScriptLoadRequest::Progress::eCompiling;

  *aCouldCompileOut = true;
  Unused << runnable.forget();
  return NS_OK;
}

nsresult
ScriptLoader::CompileOffThreadOrProcessRequest(ScriptLoadRequest* aRequest)
{
  NS_ASSERTION(nsContentUtils::IsSafeToRunScript(),
               "Processing requests when running scripts is unsafe.");
  NS_ASSERTION(!aRequest->mOffThreadToken,
               "Candidate for off-thread compile is already parsed off-thread");
  NS_ASSERTION(!aRequest->InCompilingStage(),
               "Candidate for off-thread compile is already in compiling stage.");

  bool couldCompile = false;
  nsresult rv = AttemptAsyncScriptCompile(aRequest, &couldCompile);
  if (NS_FAILED(rv)) {
    HandleLoadError(aRequest, rv);
    return rv;
  }

  if (couldCompile) {
    return NS_OK;
  }

  return ProcessRequest(aRequest);
}

mozilla::Maybe<SourceBufferHolder>
ScriptLoader::GetScriptSource(JSContext* aCx, ScriptLoadRequest* aRequest)
{
  // Return a SourceBufferHolder object holding the script's source text.
  // Ownership of the buffer is transferred to the resulting SourceBufferHolder.

  // If there's no script text, we try to get it from the element
  if (aRequest->mIsInline) {
    nsAutoString inlineData;
    aRequest->Element()->GetScriptText(inlineData);

    size_t nbytes = inlineData.Length() * sizeof(char16_t);
    JS::UniqueTwoByteChars chars(static_cast<char16_t*>(JS_malloc(aCx, nbytes)));
    if (!chars) {
      return Nothing();
    }

    memcpy(chars.get(), inlineData.get(), nbytes);
    return Some(SourceBufferHolder(std::move(chars), inlineData.Length()));
  }

  size_t length = aRequest->ScriptText().length();
  JS::UniqueTwoByteChars chars(aRequest->ScriptText().extractOrCopyRawBuffer());
  return Some(SourceBufferHolder(std::move(chars), length));
}

nsresult
ScriptLoader::ProcessRequest(ScriptLoadRequest* aRequest)
{
  LOG(("ScriptLoadRequest (%p): Process request", aRequest));

  NS_ASSERTION(nsContentUtils::IsSafeToRunScript(),
               "Processing requests when running scripts is unsafe.");
  NS_ASSERTION(aRequest->IsReadyToRun(),
               "Processing a request that is not ready to run.");

  NS_ENSURE_ARG(aRequest);

  if (aRequest->IsModuleRequest()) {
    ModuleLoadRequest* request = aRequest->AsModuleRequest();
    if (request->mModuleScript && !request->mModuleScript->HasErrorToRethrow()) {
      if (!InstantiateModuleTree(request)) {
        request->mModuleScript = nullptr;
      }
    }

    if (!request->mModuleScript) {
      // There was an error fetching a module script.  Nothing to do here.
      LOG(("ScriptLoadRequest (%p):   Error loading request, firing error", aRequest));
      FireScriptAvailable(NS_ERROR_FAILURE, aRequest);
      return NS_OK;
    }
  }

  nsCOMPtr<nsINode> scriptElem = do_QueryInterface(aRequest->Element());

  nsCOMPtr<nsIDocument> doc;
  if (!aRequest->mIsInline) {
    doc = scriptElem->OwnerDoc();
  }

  nsCOMPtr<nsIScriptElement> oldParserInsertedScript;
  uint32_t parserCreated = aRequest->Element()->GetParserCreated();
  if (parserCreated) {
    oldParserInsertedScript = mCurrentParserInsertedScript;
    mCurrentParserInsertedScript = aRequest->Element();
  }

  aRequest->Element()->BeginEvaluating();

  FireScriptAvailable(NS_OK, aRequest);

  // The window may have gone away by this point, in which case there's no point
  // in trying to run the script.

  {
    // Try to perform a microtask checkpoint
    nsAutoMicroTask mt;
  }

  nsPIDOMWindowInner* pwin = mDocument->GetInnerWindow();
  bool runScript = !!pwin;
  if (runScript) {
    nsContentUtils::DispatchTrustedEvent(scriptElem->OwnerDoc(),
                                         scriptElem,
                                         NS_LITERAL_STRING("beforescriptexecute"),
                                         CanBubble::eYes, Cancelable::eYes, &runScript);
  }

  // Inner window could have gone away after firing beforescriptexecute
  pwin = mDocument->GetInnerWindow();
  if (!pwin) {
    runScript = false;
  }

  nsresult rv = NS_OK;
  if (runScript) {
    if (doc) {
      doc->IncrementIgnoreDestructiveWritesCounter();
    }
    rv = EvaluateScript(aRequest);
    if (doc) {
      doc->DecrementIgnoreDestructiveWritesCounter();
    }

    nsContentUtils::DispatchTrustedEvent(scriptElem->OwnerDoc(),
                                         scriptElem,
                                         NS_LITERAL_STRING("afterscriptexecute"),
                                         CanBubble::eYes, Cancelable::eNo);
  }

  FireScriptEvaluated(rv, aRequest);

  aRequest->Element()->EndEvaluating();

  if (parserCreated) {
    mCurrentParserInsertedScript = oldParserInsertedScript;
  }

  if (aRequest->mOffThreadToken) {
    // The request was parsed off-main-thread, but the result of the off
    // thread parse was not actually needed to process the request
    // (disappearing window, some other error, ...). Finish the
    // request to avoid leaks in the JS engine.
    MOZ_ASSERT(!aRequest->IsModuleRequest());
    aRequest->MaybeCancelOffThreadScript();
  }

  // Free any source data, but keep the bytecode content as we might have to
  // save it later.
  aRequest->ClearScriptSource();
  if (aRequest->IsBytecode()) {
    // We received bytecode as input, thus we were decoding, and we will not be
    // encoding the bytecode once more. We can safely clear the content of this
    // buffer.
    aRequest->mScriptBytecode.clearAndFree();
  }

  return rv;
}

void
ScriptLoader::FireScriptAvailable(nsresult aResult,
                                  ScriptLoadRequest* aRequest)
{
  for (int32_t i = 0; i < mObservers.Count(); i++) {
    nsCOMPtr<nsIScriptLoaderObserver> obs = mObservers[i];
    obs->ScriptAvailable(aResult, aRequest->Element(),
                         aRequest->mIsInline, aRequest->mURI,
                         aRequest->mLineNo);
  }

  aRequest->FireScriptAvailable(aResult);
}

void
ScriptLoader::FireScriptEvaluated(nsresult aResult,
                                  ScriptLoadRequest* aRequest)
{
  for (int32_t i = 0; i < mObservers.Count(); i++) {
    nsCOMPtr<nsIScriptLoaderObserver> obs = mObservers[i];
    obs->ScriptEvaluated(aResult, aRequest->Element(),
                         aRequest->mIsInline);
  }

  aRequest->FireScriptEvaluated(aResult);
}

already_AddRefed<nsIScriptGlobalObject>
ScriptLoader::GetScriptGlobalObject()
{
  if (!mDocument) {
    return nullptr;
  }

  nsPIDOMWindowInner* pwin = mDocument->GetInnerWindow();
  if (!pwin) {
    return nullptr;
  }

  nsCOMPtr<nsIScriptGlobalObject> globalObject = do_QueryInterface(pwin);
  NS_ASSERTION(globalObject, "windows must be global objects");

  // and make sure we are setup for this type of script.
  nsresult rv = globalObject->EnsureScriptEnvironment();
  if (NS_FAILED(rv)) {
    return nullptr;
  }

  return globalObject.forget();
}

nsresult
ScriptLoader::FillCompileOptionsForRequest(const AutoJSAPI&jsapi,
                                           ScriptLoadRequest* aRequest,
                                           JS::Handle<JSObject*> aScopeChain,
                                           JS::CompileOptions* aOptions)
{
  // It's very important to use aRequest->mURI, not the final URI of the channel
  // aRequest ended up getting script data from, as the script filename.
  nsresult rv;
  nsContentUtils::GetWrapperSafeScriptFilename(mDocument, aRequest->mURI,
                                               aRequest->mURL, &rv);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }

  if (mDocument) {
    mDocument->NoteScriptTrackingStatus(aRequest->mURL, aRequest->IsTracking());
  }

  bool isScriptElement = !aRequest->IsModuleRequest() ||
                         aRequest->AsModuleRequest()->IsTopLevel();
  aOptions->setIntroductionType(isScriptElement ? "scriptElement"
                                                : "importedModule");
  aOptions->setFileAndLine(aRequest->mURL.get(), aRequest->mLineNo);
  aOptions->setIsRunOnce(true);
  aOptions->setNoScriptRval(true);
  if (aRequest->mHasSourceMapURL) {
    aOptions->setSourceMapURL(aRequest->mSourceMapURL.get());
  }
  if (aRequest->mOriginPrincipal) {
    nsIPrincipal* scriptPrin = nsContentUtils::ObjectPrincipal(aScopeChain);
    bool subsumes = scriptPrin->Subsumes(aRequest->mOriginPrincipal);
    aOptions->setMutedErrors(!subsumes);
  }

  if (aRequest->IsModuleRequest()) {
    aOptions->hideScriptFromDebugger = true;
  } else {
    JSContext* cx = jsapi.cx();
    JS::Rooted<JS::Value> elementVal(cx);
    MOZ_ASSERT(aRequest->Element());
    if (NS_SUCCEEDED(nsContentUtils::WrapNative(cx, aRequest->Element(),
                                                &elementVal,
                                                /* aAllowWrapping = */ true))) {
      MOZ_ASSERT(elementVal.isObject());
      aOptions->setElement(&elementVal.toObject());
    }
  }

  return NS_OK;
}

/* static */ bool
ScriptLoader::ShouldCacheBytecode(ScriptLoadRequest* aRequest)
{
  using mozilla::TimeStamp;
  using mozilla::TimeDuration;

  // We need the nsICacheInfoChannel to exist to be able to open the alternate
  // data output stream. This pointer would only be non-null if the bytecode was
  // activated at the time the channel got created in StartLoad.
  if (!aRequest->mCacheInfo) {
    LOG(("ScriptLoadRequest (%p): Cannot cache anything (cacheInfo = %p)",
         aRequest, aRequest->mCacheInfo.get()));
    return false;
  }

  // Look at the preference to know which strategy (parameters) should be used
  // when the bytecode cache is enabled.
  int32_t strategy = nsContentUtils::BytecodeCacheStrategy();

  // List of parameters used by the strategies.
  bool hasSourceLengthMin = false;
  bool hasFetchCountMin = false;
  size_t sourceLengthMin = 100;
  size_t binASTLengthMin = 70;
  int32_t fetchCountMin = 4;

  LOG(("ScriptLoadRequest (%p): Bytecode-cache: strategy = %d.", aRequest, strategy));
  switch (strategy) {
    case -2: {
      // Reader mode, keep requesting alternate data but no longer save it.
      LOG(("ScriptLoadRequest (%p): Bytecode-cache: Encoding disabled.", aRequest));
      return false;
    }
    case -1: {
      // Eager mode, skip heuristics!
      hasSourceLengthMin = false;
      hasFetchCountMin = false;
      break;
    }
    default:
    case 0: {
      hasSourceLengthMin = true;
      hasFetchCountMin = true;
      sourceLengthMin = 1024;
      binASTLengthMin = 700;
      // If we were to optimize only for speed, without considering the impact
      // on memory, we should set this threshold to 2. (Bug 900784 comment 120)
      fetchCountMin = 4;
      break;
    }
  }

  // If the script is too small/large, do not attempt at creating a bytecode
  // cache for this script, as the overhead of parsing it might not be worth the
  // effort.
  if (hasSourceLengthMin) {
    size_t sourceLength;
    size_t minLength;
    if (aRequest->IsTextSource()) {
      sourceLength = aRequest->mScriptTextLength;
      minLength = sourceLengthMin;
    } else {
      MOZ_ASSERT(aRequest->IsBinASTSource());
      sourceLength = aRequest->ScriptBinASTData().length();
      minLength = binASTLengthMin;
    }
    if (sourceLength < minLength) {
      LOG(("ScriptLoadRequest (%p): Bytecode-cache: Script is too small.", aRequest));
      return false;
    }
  }

  // Check that we loaded the cache entry a few times before attempting any
  // bytecode-cache optimization, such that we do not waste time on entry which
  // are going to be dropped soon.
  if (hasFetchCountMin) {
    int32_t fetchCount = 0;
    if (NS_FAILED(aRequest->mCacheInfo->GetCacheTokenFetchCount(&fetchCount))) {
      LOG(("ScriptLoadRequest (%p): Bytecode-cache: Cannot get fetchCount.", aRequest));
      return false;
    }
    LOG(("ScriptLoadRequest (%p): Bytecode-cache: fetchCount = %d.", aRequest, fetchCount));
    if (fetchCount < fetchCountMin) {
      return false;
    }
  }

  LOG(("ScriptLoadRequest (%p): Bytecode-cache: Trigger encoding.", aRequest));
  return true;
}

nsresult
ScriptLoader::EvaluateScript(ScriptLoadRequest* aRequest)
{
  using namespace mozilla::Telemetry;
  MOZ_ASSERT(aRequest->IsReadyToRun());

  // We need a document to evaluate scripts.
  if (!mDocument) {
    return NS_ERROR_FAILURE;
  }

  nsCOMPtr<nsIContent> scriptContent(do_QueryInterface(aRequest->Element()));
  nsIDocument* ownerDoc = scriptContent->OwnerDoc();
  if (ownerDoc != mDocument) {
    // Willful violation of HTML5 as of 2010-12-01
    return NS_ERROR_FAILURE;
  }

  // Get the script-type to be used by this element.
  NS_ASSERTION(scriptContent, "no content - what is default script-type?");

  nsCOMPtr<nsIScriptGlobalObject> globalObject = GetScriptGlobalObject();
  if (!globalObject) {
    return NS_ERROR_FAILURE;
  }

  // Make sure context is a strong reference since we access it after
  // we've executed a script, which may cause all other references to
  // the context to go away.
  nsCOMPtr<nsIScriptContext> context = globalObject->GetScriptContext();
  if (!context) {
    return NS_ERROR_FAILURE;
  }

  // New script entry point required, due to the "Create a script" sub-step of
  // http://www.whatwg.org/specs/web-apps/current-work/#execute-the-script-block
  nsAutoMicroTask mt;
  AutoEntryScript aes(globalObject, "<script> element", true);
  JSContext* cx = aes.cx();
  JS::Rooted<JSObject*> global(cx, globalObject->GetGlobalJSObject());

  bool oldProcessingScriptTag = context->GetProcessingScriptTag();
  context->SetProcessingScriptTag(true);
  nsresult rv;
  {
    if (aRequest->IsModuleRequest()) {
      // When a module is already loaded, it is not feched a second time and the
      // mDataType of the request might remain set to DataType::Unknown.
      MOZ_ASSERT(aRequest->IsTextSource() || aRequest->IsUnknownDataType());
      LOG(("ScriptLoadRequest (%p): Evaluate Module", aRequest));

      // currentScript is set to null for modules.
      AutoCurrentScriptUpdater scriptUpdater(this, nullptr);

      EnsureModuleResolveHook(cx);

      ModuleLoadRequest* request = aRequest->AsModuleRequest();
      MOZ_ASSERT(request->mModuleScript);
      MOZ_ASSERT(!request->mOffThreadToken);

      ModuleScript* moduleScript = request->mModuleScript;
      if (moduleScript->HasErrorToRethrow()) {
        LOG(("ScriptLoadRequest (%p):   module has error to rethrow", aRequest));
        JS::Rooted<JS::Value> error(cx, moduleScript->ErrorToRethrow());
        JS_SetPendingException(cx, error);
        return NS_OK; // An error is reported by AutoEntryScript.
      }

      JS::Rooted<JSScript*> script(cx, moduleScript->Script());
      MOZ_ASSERT(script);

      if (!moduleScript->SourceElementAssociated()) {
        rv = AssociateSourceElementsForModuleTree(cx, request);
        NS_ENSURE_SUCCESS(rv, rv);
      }

      rv = nsJSUtils::ModuleEvaluate(cx, script);
      MOZ_ASSERT(NS_FAILED(rv) == aes.HasException());
      if (NS_FAILED(rv)) {
        LOG(("ScriptLoadRequest (%p):   evaluation failed", aRequest));
        rv = NS_OK; // An error is reported by AutoEntryScript.
      }

      aRequest->mCacheInfo = nullptr;
    } else {
      // Update our current script.
      AutoCurrentScriptUpdater scriptUpdater(this, aRequest->Element());

      JS::CompileOptions options(cx);
      rv = FillCompileOptionsForRequest(aes, aRequest, global, &options);

      if (NS_SUCCEEDED(rv)) {
        if (aRequest->IsBytecode()) {
          TRACE_FOR_TEST(aRequest->Element(), "scriptloader_execute");
          nsJSUtils::ExecutionContext exec(cx, global);
          if (aRequest->mOffThreadToken) {
            LOG(("ScriptLoadRequest (%p): Decode Bytecode & Join and Execute", aRequest));
            rv = exec.DecodeJoinAndExec(&aRequest->mOffThreadToken);
          } else {
            LOG(("ScriptLoadRequest (%p): Decode Bytecode and Execute", aRequest));
            rv = exec.DecodeAndExec(options, aRequest->mScriptBytecode,
                                    aRequest->mBytecodeOffset);
          }
          // We do not expect to be saving anything when we already have some
          // bytecode.
          MOZ_ASSERT(!aRequest->mCacheInfo);
        } else {
          MOZ_ASSERT(aRequest->IsSource());
          JS::Rooted<JSScript*> script(cx);
          bool encodeBytecode = ShouldCacheBytecode(aRequest);

          {
            nsJSUtils::ExecutionContext exec(cx, global);
            exec.SetEncodeBytecode(encodeBytecode);
            TRACE_FOR_TEST(aRequest->Element(), "scriptloader_execute");
            if (aRequest->mOffThreadToken) {
              // Off-main-thread parsing.
              LOG(("ScriptLoadRequest (%p): Join (off-thread parsing) and Execute",
                   aRequest));
              if (aRequest->IsBinASTSource()) {
                rv = exec.DecodeBinASTJoinAndExec(&aRequest->mOffThreadToken, &script);
              } else {
                MOZ_ASSERT(aRequest->IsTextSource());
                rv = exec.JoinAndExec(&aRequest->mOffThreadToken, &script);
              }
            } else {
              // Main thread parsing (inline and small scripts)
              LOG(("ScriptLoadRequest (%p): Compile And Exec", aRequest));
              if (aRequest->IsBinASTSource()) {
                rv = exec.DecodeBinASTAndExec(options,
                                              aRequest->ScriptBinASTData().begin(),
                                              aRequest->ScriptBinASTData().length(),
                                              &script);
              } else {
                MOZ_ASSERT(aRequest->IsTextSource());
                auto srcBuf = GetScriptSource(cx, aRequest);

                if (srcBuf) {
                  if (recordreplay::IsRecordingOrReplaying()) {
                    recordreplay::NoteContentParse(this, options.filename(), "application/javascript",
                                                   srcBuf->get(), srcBuf->length());
                  }
                  rv = exec.CompileAndExec(options, *srcBuf, &script);
                } else {
                  rv = NS_ERROR_OUT_OF_MEMORY;
                }
              }
            }
          }

          // Queue the current script load request to later save the bytecode.
          if (script && encodeBytecode) {
            aRequest->mScript = script;
            HoldJSObjects(aRequest);
            TRACE_FOR_TEST(aRequest->Element(), "scriptloader_encode");
            MOZ_ASSERT(aRequest->mBytecodeOffset == aRequest->mScriptBytecode.length());
            RegisterForBytecodeEncoding(aRequest);
          } else {
            LOG(("ScriptLoadRequest (%p): Bytecode-cache: disabled (rv = %X, script = %p)",
                 aRequest, unsigned(rv), script.get()));
            TRACE_FOR_TEST_NONE(aRequest->Element(), "scriptloader_no_encode");
            aRequest->mCacheInfo = nullptr;
          }
        }
      }
    }

    // Even if we are not saving the bytecode of the current script, we have
    // to trigger the encoding of the bytecode, as the current script can
    // call functions of a script for which we are recording the bytecode.
    LOG(("ScriptLoadRequest (%p): ScriptLoader = %p", aRequest, this));
    MaybeTriggerBytecodeEncoding();
  }

  context->SetProcessingScriptTag(oldProcessingScriptTag);
  return rv;
}

void
ScriptLoader::RegisterForBytecodeEncoding(ScriptLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest->mCacheInfo);
  MOZ_ASSERT(aRequest->mScript);
  mBytecodeEncodingQueue.AppendElement(aRequest);
}

void
ScriptLoader::LoadEventFired()
{
  mLoadEventFired = true;
  MaybeTriggerBytecodeEncoding();
}

void
ScriptLoader::MaybeTriggerBytecodeEncoding()
{
  // If we already gave up, ensure that we are not going to enqueue any script,
  // and that we finalize them properly.
  if (mGiveUpEncoding) {
    LOG(("ScriptLoader (%p): Keep giving-up bytecode encoding.", this));
    GiveUpBytecodeEncoding();
    return;
  }

  // We wait for the load event to be fired before saving the bytecode of
  // any script to the cache. It is quite common to have load event
  // listeners trigger more JavaScript execution, that we want to save as
  // part of this start-up bytecode cache.
  if (!mLoadEventFired) {
    LOG(("ScriptLoader (%p): Wait for the load-end event to fire.", this));
    return;
  }

  // No need to fire any event if there is no bytecode to be saved.
  if (mBytecodeEncodingQueue.isEmpty()) {
    LOG(("ScriptLoader (%p): No script in queue to be encoded.", this));
    return;
  }

  // Wait until all scripts are loaded before saving the bytecode, such that
  // we capture most of the intialization of the page.
  if (HasPendingRequests()) {
    LOG(("ScriptLoader (%p): Wait for other pending request to finish.", this));
    return;
  }

  // Create a new runnable dedicated to encoding the content of the bytecode of
  // all enqueued scripts when the document is idle. In case of failure, we
  // give-up on encoding the bytecode.
  nsCOMPtr<nsIRunnable> encoder =
    NewRunnableMethod("ScriptLoader::EncodeBytecode",
                      this, &ScriptLoader::EncodeBytecode);
  if (NS_FAILED(NS_IdleDispatchToCurrentThread(encoder.forget()))) {
    GiveUpBytecodeEncoding();
    return;
  }

  LOG(("ScriptLoader (%p): Schedule bytecode encoding.", this));
}

void
ScriptLoader::EncodeBytecode()
{
  LOG(("ScriptLoader (%p): Start bytecode encoding.", this));

  // If any script got added in the previous loop cycle, wait until all
  // remaining script executions are completed, such that we capture most of
  // the initialization.
  if (HasPendingRequests()) {
    return;
  }

  nsCOMPtr<nsIScriptGlobalObject> globalObject = GetScriptGlobalObject();
  if (!globalObject) {
    GiveUpBytecodeEncoding();
    return;
  }

  nsCOMPtr<nsIScriptContext> context = globalObject->GetScriptContext();
  if (!context) {
    GiveUpBytecodeEncoding();
    return;
  }

  AutoEntryScript aes(globalObject, "encode bytecode", true);
  RefPtr<ScriptLoadRequest> request;
  while (!mBytecodeEncodingQueue.isEmpty()) {
    request = mBytecodeEncodingQueue.StealFirst();
    EncodeRequestBytecode(aes.cx(), request);
    request->mScriptBytecode.clearAndFree();
    request->DropBytecodeCacheReferences();
  }
}

void
ScriptLoader::EncodeRequestBytecode(JSContext* aCx, ScriptLoadRequest* aRequest)
{
  using namespace mozilla::Telemetry;
  nsresult rv = NS_OK;
  MOZ_ASSERT(aRequest->mCacheInfo);
  auto bytecodeFailed = mozilla::MakeScopeExit([&]() {
    TRACE_FOR_TEST_NONE(aRequest->Element(), "scriptloader_bytecode_failed");
  });

  JS::RootedScript script(aCx, aRequest->mScript);
  if (!JS::FinishIncrementalEncoding(aCx, script, aRequest->mScriptBytecode)) {
    LOG(("ScriptLoadRequest (%p): Cannot serialize bytecode",
         aRequest));
    return;
  }

  if (aRequest->mScriptBytecode.length() >= UINT32_MAX) {
    LOG(("ScriptLoadRequest (%p): Bytecode cache is too large to be decoded correctly.",
         aRequest));
    return;
  }

  // Open the output stream to the cache entry alternate data storage. This
  // might fail if the stream is already open by another request, in which
  // case, we just ignore the current one.
  nsCOMPtr<nsIOutputStream> output;
  rv = aRequest->mCacheInfo->OpenAlternativeOutputStream(nsContentUtils::JSBytecodeMimeType(),
                                                         aRequest->mScriptBytecode.length(),
                                                         getter_AddRefs(output));
  if (NS_FAILED(rv)) {
    LOG(("ScriptLoadRequest (%p): Cannot open bytecode cache (rv = %X, output = %p)",
         aRequest, unsigned(rv), output.get()));
    return;
  }
  MOZ_ASSERT(output);
  auto closeOutStream = mozilla::MakeScopeExit([&]() {
    nsresult rv = output->Close();
    LOG(("ScriptLoadRequest (%p): Closing (rv = %X)",
         aRequest, unsigned(rv)));
  });

  uint32_t n;
  rv = output->Write(reinterpret_cast<char*>(aRequest->mScriptBytecode.begin()),
                     aRequest->mScriptBytecode.length(), &n);
  LOG(("ScriptLoadRequest (%p): Write bytecode cache (rv = %X, length = %u, written = %u)",
       aRequest, unsigned(rv), unsigned(aRequest->mScriptBytecode.length()), n));
  if (NS_FAILED(rv)) {
    return;
  }

  bytecodeFailed.release();
  TRACE_FOR_TEST_NONE(aRequest->Element(), "scriptloader_bytecode_saved");
}

void
ScriptLoader::GiveUpBytecodeEncoding()
{
  // If the document went away prematurely, we still want to set this, in order
  // to avoid queuing more scripts.
  mGiveUpEncoding = true;

  // Ideally we prefer to properly end the incremental encoder, such that we
  // would not keep a large buffer around.  If we cannot, we fallback on the
  // removal of all request from the current list and these large buffers would
  // be removed at the same time as the source object.
  nsCOMPtr<nsIScriptGlobalObject> globalObject = GetScriptGlobalObject();
  Maybe<AutoEntryScript> aes;

  if (globalObject) {
    nsCOMPtr<nsIScriptContext> context = globalObject->GetScriptContext();
    if (context) {
      aes.emplace(globalObject, "give-up bytecode encoding", true);
    }
  }

  while (!mBytecodeEncodingQueue.isEmpty()) {
    RefPtr<ScriptLoadRequest> request = mBytecodeEncodingQueue.StealFirst();
    LOG(("ScriptLoadRequest (%p): Cannot serialize bytecode", request.get()));
    TRACE_FOR_TEST_NONE(request->Element(), "scriptloader_bytecode_failed");

    if (aes.isSome()) {
      JS::RootedScript script(aes->cx(), request->mScript);
      Unused << JS::FinishIncrementalEncoding(aes->cx(), script,
                                              request->mScriptBytecode);
    }

    request->mScriptBytecode.clearAndFree();
    request->DropBytecodeCacheReferences();
  }
}

bool
ScriptLoader::HasPendingRequests()
{
  return mParserBlockingRequest ||
         !mXSLTRequests.isEmpty() ||
         !mLoadedAsyncRequests.isEmpty() ||
         !mNonAsyncExternalScriptInsertedRequests.isEmpty() ||
         !mDeferRequests.isEmpty() ||
         !mPendingChildLoaders.IsEmpty();
}

void
ScriptLoader::ProcessPendingRequestsAsync()
{
  if (HasPendingRequests()) {
    nsCOMPtr<nsIRunnable> task =
      NewRunnableMethod("dom::ScriptLoader::ProcessPendingRequests",
                        this,
                        &ScriptLoader::ProcessPendingRequests);
    if (mDocument) {
      mDocument->Dispatch(TaskCategory::Other, task.forget());
    } else {
      NS_DispatchToCurrentThread(task.forget());
    }
  }
}

void
ScriptLoader::ProcessPendingRequests()
{
  RefPtr<ScriptLoadRequest> request;

  if (mParserBlockingRequest &&
      mParserBlockingRequest->IsReadyToRun() &&
      ReadyToExecuteParserBlockingScripts()) {
    request.swap(mParserBlockingRequest);
    UnblockParser(request);
    ProcessRequest(request);
    if (request->mWasCompiledOMT) {
      mDocument->UnblockOnload(false);
    }
    ContinueParserAsync(request);
  }

  while (ReadyToExecuteParserBlockingScripts() &&
         !mXSLTRequests.isEmpty() &&
         mXSLTRequests.getFirst()->IsReadyToRun()) {
    request = mXSLTRequests.StealFirst();
    ProcessRequest(request);
  }

  while (ReadyToExecuteScripts() && !mLoadedAsyncRequests.isEmpty()) {
    request = mLoadedAsyncRequests.StealFirst();
    if (request->IsModuleRequest()) {
      ProcessRequest(request);
    } else {
      CompileOffThreadOrProcessRequest(request);
    }
  }

  while (ReadyToExecuteScripts() &&
         !mNonAsyncExternalScriptInsertedRequests.isEmpty() &&
         mNonAsyncExternalScriptInsertedRequests.getFirst()->IsReadyToRun()) {
    // Violate the HTML5 spec and execute these in the insertion order in
    // order to make LABjs and the "order" plug-in for RequireJS work with
    // their Gecko-sniffed code path. See
    // http://lists.w3.org/Archives/Public/public-html/2010Oct/0088.html
    request = mNonAsyncExternalScriptInsertedRequests.StealFirst();
    ProcessRequest(request);
  }

  if (mDocumentParsingDone && mXSLTRequests.isEmpty()) {
    while (ReadyToExecuteScripts() &&
           !mDeferRequests.isEmpty() &&
           mDeferRequests.getFirst()->IsReadyToRun()) {
      request = mDeferRequests.StealFirst();
      ProcessRequest(request);
    }
  }

  while (!mPendingChildLoaders.IsEmpty() &&
         ReadyToExecuteParserBlockingScripts()) {
    RefPtr<ScriptLoader> child = mPendingChildLoaders[0];
    mPendingChildLoaders.RemoveElementAt(0);
    child->RemoveParserBlockingScriptExecutionBlocker();
  }

  if (mDocumentParsingDone && mDocument && !mParserBlockingRequest &&
      mNonAsyncExternalScriptInsertedRequests.isEmpty() &&
      mXSLTRequests.isEmpty() && mDeferRequests.isEmpty() &&
      MaybeRemovedDeferRequests()) {
    return ProcessPendingRequests();
  }

  if (mDocumentParsingDone && mDocument &&
      !mParserBlockingRequest && mLoadingAsyncRequests.isEmpty() &&
      mLoadedAsyncRequests.isEmpty() &&
      mNonAsyncExternalScriptInsertedRequests.isEmpty() &&
      mXSLTRequests.isEmpty() && mDeferRequests.isEmpty()) {
    // No more pending scripts; time to unblock onload.
    // OK to unblock onload synchronously here, since callers must be
    // prepared for the world changing anyway.
    mDocumentParsingDone = false;
    mDocument->UnblockOnload(true);
  }
}

bool
ScriptLoader::ReadyToExecuteParserBlockingScripts()
{
  // Make sure the SelfReadyToExecuteParserBlockingScripts check is first, so
  // that we don't block twice on an ancestor.
  if (!SelfReadyToExecuteParserBlockingScripts()) {
    return false;
  }

  for (nsIDocument* doc = mDocument; doc; doc = doc->GetParentDocument()) {
    ScriptLoader* ancestor = doc->ScriptLoader();
    if (!ancestor->SelfReadyToExecuteParserBlockingScripts() &&
        ancestor->AddPendingChildLoader(this)) {
      AddParserBlockingScriptExecutionBlocker();
      return false;
    }
  }

  return true;
}

/* static */ nsresult
ScriptLoader::ConvertToUTF16(nsIChannel* aChannel, const uint8_t* aData,
                             uint32_t aLength, const nsAString& aHintCharset,
                             nsIDocument* aDocument,
                             char16_t*& aBufOut, size_t& aLengthOut)
{
  if (!aLength) {
    aBufOut = nullptr;
    aLengthOut = 0;
    return NS_OK;
  }

  auto data = MakeSpan(aData, aLength);

  // The encoding info precedence is as follows from high to low:
  // The BOM
  // HTTP Content-Type (if name recognized)
  // charset attribute (if name recognized)
  // The encoding of the document

  UniquePtr<Decoder> unicodeDecoder;

  const Encoding* encoding;
  size_t bomLength;
  Tie(encoding, bomLength) = Encoding::ForBOM(data);
  if (encoding) {
    unicodeDecoder = encoding->NewDecoderWithBOMRemoval();
  }

  if (!unicodeDecoder && aChannel) {
    nsAutoCString label;
    if (NS_SUCCEEDED(aChannel->GetContentCharset(label)) &&
        (encoding = Encoding::ForLabel(label))) {
      unicodeDecoder = encoding->NewDecoderWithoutBOMHandling();
    }
  }

  if (!unicodeDecoder && (encoding = Encoding::ForLabel(aHintCharset))) {
    unicodeDecoder = encoding->NewDecoderWithoutBOMHandling();
  }

  if (!unicodeDecoder && aDocument) {
    unicodeDecoder = aDocument->GetDocumentCharacterSet()
                       ->NewDecoderWithoutBOMHandling();
  }

  if (!unicodeDecoder) {
    // Curiously, there are various callers that don't pass aDocument. The
    // fallback in the old code was ISO-8859-1, which behaved like
    // windows-1252.
    unicodeDecoder = WINDOWS_1252_ENCODING->NewDecoderWithoutBOMHandling();
  }

  CheckedInt<size_t> unicodeLength =
    unicodeDecoder->MaxUTF16BufferLength(aLength);
  if (!unicodeLength.isValid()) {
    return NS_ERROR_OUT_OF_MEMORY;
  }

  aBufOut =
    static_cast<char16_t*>(js_malloc(unicodeLength.value() * sizeof(char16_t)));
  if (!aBufOut) {
    aLengthOut = 0;
    return NS_ERROR_OUT_OF_MEMORY;
  }

  uint32_t result;
  size_t read;
  size_t written;
  bool hadErrors;
  Tie(result, read, written, hadErrors) = unicodeDecoder->DecodeToUTF16(
    data, MakeSpan(aBufOut, unicodeLength.value()), true);
  MOZ_ASSERT(result == kInputEmpty);
  MOZ_ASSERT(read == aLength);
  MOZ_ASSERT(written <= unicodeLength.value());
  Unused << hadErrors;
  aLengthOut = written;

  return NS_OK;
}

nsresult
ScriptLoader::OnStreamComplete(nsIIncrementalStreamLoader* aLoader,
                               ScriptLoadRequest* aRequest,
                               nsresult aChannelStatus,
                               nsresult aSRIStatus,
                               SRICheckDataVerifier* aSRIDataVerifier)
{
  NS_ASSERTION(aRequest, "null request in stream complete handler");
  NS_ENSURE_TRUE(aRequest, NS_ERROR_FAILURE);

  nsresult rv = VerifySRI(aRequest, aLoader, aSRIStatus, aSRIDataVerifier);

  if (NS_SUCCEEDED(rv)) {
    // If we are loading from source, save the computed SRI hash or a dummy SRI
    // hash in case we are going to save the bytecode of this script in the cache.
    if (aRequest->IsSource()) {
      rv = SaveSRIHash(aRequest, aSRIDataVerifier);
    }

    if (NS_SUCCEEDED(rv)) {
      rv = PrepareLoadedRequest(aRequest, aLoader, aChannelStatus);
    }

    if (NS_FAILED(rv)) {
      ReportErrorToConsole(aRequest, rv);
    }
  }

  if (NS_FAILED(rv)) {
    // When loading bytecode, we verify the SRI hash. If it does not match the
    // one from the document we restart the load, forcing us to load the source
    // instead. If this happens do not remove the current request from script
    // loader's data structures or fire any events.
    if (aChannelStatus != NS_BINDING_RETARGETED) {
      HandleLoadError(aRequest, rv);
    }
  }

  // Process our request and/or any pending ones
  ProcessPendingRequests();

  return NS_OK;
}

nsresult
ScriptLoader::VerifySRI(ScriptLoadRequest* aRequest,
                        nsIIncrementalStreamLoader* aLoader,
                        nsresult aSRIStatus,
                        SRICheckDataVerifier* aSRIDataVerifier) const
{
  nsCOMPtr<nsIRequest> channelRequest;
  aLoader->GetRequest(getter_AddRefs(channelRequest));
  nsCOMPtr<nsIChannel> channel;
  channel = do_QueryInterface(channelRequest);

  nsresult rv = NS_OK;
  if (!aRequest->mIntegrity.IsEmpty() &&
      NS_SUCCEEDED((rv = aSRIStatus))) {
    MOZ_ASSERT(aSRIDataVerifier);
    MOZ_ASSERT(mReporter);

    nsAutoCString sourceUri;
    if (mDocument && mDocument->GetDocumentURI()) {
      mDocument->GetDocumentURI()->GetAsciiSpec(sourceUri);
    }
    rv = aSRIDataVerifier->Verify(aRequest->mIntegrity, channel, sourceUri,
                                  mReporter);
    if (channelRequest) {
      mReporter->FlushReportsToConsole(
        nsContentUtils::GetInnerWindowID(channelRequest));
    } else {
      mReporter->FlushConsoleReports(mDocument);
    }
    if (NS_FAILED(rv)) {
      rv = NS_ERROR_SRI_CORRUPT;
    }
  } else {
    nsCOMPtr<nsILoadInfo> loadInfo = channel->GetLoadInfo();

    if (loadInfo && loadInfo->GetEnforceSRI()) {
      MOZ_LOG(SRILogHelper::GetSriLog(), mozilla::LogLevel::Debug,
              ("ScriptLoader::OnStreamComplete, required SRI not found"));
      nsCOMPtr<nsIContentSecurityPolicy> csp;
      loadInfo->LoadingPrincipal()->GetCsp(getter_AddRefs(csp));
      nsAutoCString violationURISpec;
      mDocument->GetDocumentURI()->GetAsciiSpec(violationURISpec);
      uint32_t lineNo = aRequest->Element() ? aRequest->Element()->GetScriptLineNumber() : 0;
      uint32_t columnNo = aRequest->Element() ? aRequest->Element()->GetScriptColumnNumber() : 0;
      csp->LogViolationDetails(
        nsIContentSecurityPolicy::VIOLATION_TYPE_REQUIRE_SRI_FOR_SCRIPT,
        nullptr, // triggering element
        NS_ConvertUTF8toUTF16(violationURISpec),
        EmptyString(), lineNo, columnNo, EmptyString(), EmptyString());
      rv = NS_ERROR_SRI_CORRUPT;
    }
  }

  return rv;
}

nsresult
ScriptLoader::SaveSRIHash(ScriptLoadRequest *aRequest,
                          SRICheckDataVerifier* aSRIDataVerifier) const
{
  MOZ_ASSERT(aRequest->IsSource());
  MOZ_ASSERT(aRequest->mScriptBytecode.empty());

  // If the integrity metadata does not correspond to a valid hash function,
  // IsComplete would be false.
  if (!aRequest->mIntegrity.IsEmpty() && aSRIDataVerifier->IsComplete()) {
    // Encode the SRI computed hash.
    uint32_t len = aSRIDataVerifier->DataSummaryLength();
    if (!aRequest->mScriptBytecode.growBy(len)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    aRequest->mBytecodeOffset = len;

    DebugOnly<nsresult> res = aSRIDataVerifier->ExportDataSummary(
      aRequest->mScriptBytecode.length(),
      aRequest->mScriptBytecode.begin());
    MOZ_ASSERT(NS_SUCCEEDED(res));
  } else {
    // Encode a dummy SRI hash.
    uint32_t len = SRICheckDataVerifier::EmptyDataSummaryLength();
    if (!aRequest->mScriptBytecode.growBy(len)) {
      return NS_ERROR_OUT_OF_MEMORY;
    }
    aRequest->mBytecodeOffset = len;

    DebugOnly<nsresult> res = SRICheckDataVerifier::ExportEmptyDataSummary(
      aRequest->mScriptBytecode.length(),
      aRequest->mScriptBytecode.begin());
    MOZ_ASSERT(NS_SUCCEEDED(res));
  }

  // Verify that the exported and predicted length correspond.
  mozilla::DebugOnly<uint32_t> srilen;
  MOZ_ASSERT(NS_SUCCEEDED(SRICheckDataVerifier::DataSummaryLength(
                            aRequest->mScriptBytecode.length(),
                            aRequest->mScriptBytecode.begin(),
                            &srilen)));
  MOZ_ASSERT(srilen == aRequest->mBytecodeOffset);

  return NS_OK;
}

void
ScriptLoader::ReportErrorToConsole(ScriptLoadRequest *aRequest,
                                   nsresult aResult) const
{
  MOZ_ASSERT(aRequest);

  if (!aRequest->Element()) {
    return;
  }

  bool isScript = !aRequest->IsModuleRequest();
  const char* message;
  if (aResult == NS_ERROR_MALFORMED_URI) {
    message =
      isScript ? "ScriptSourceMalformed" : "ModuleSourceMalformed";
  }
  else if (aResult == NS_ERROR_DOM_BAD_URI) {
    message =
      isScript ? "ScriptSourceNotAllowed" : "ModuleSourceNotAllowed";
  } else {
    message =
      isScript ? "ScriptSourceLoadFailed" : "ModuleSourceLoadFailed";
  }

  NS_ConvertUTF8toUTF16 url(aRequest->mURI->GetSpecOrDefault());
  const char16_t* params[] = { url.get() };

  uint32_t lineNo = aRequest->Element()->GetScriptLineNumber();
  uint32_t columnNo = aRequest->Element()->GetScriptColumnNumber();

  nsContentUtils::ReportToConsole(nsIScriptError::warningFlag,
                                  NS_LITERAL_CSTRING("Script Loader"), mDocument,
                                  nsContentUtils::eDOM_PROPERTIES, message,
                                  params, ArrayLength(params), nullptr,
                                  EmptyString(), lineNo, columnNo);
}

void
ScriptLoader::HandleLoadError(ScriptLoadRequest *aRequest, nsresult aResult)
{
  /*
   * Handle script not loading error because source was a tracking URL.
   * We make a note of this script node by including it in a dedicated
   * array of blocked tracking nodes under its parent document.
   */
  if (aResult == NS_ERROR_TRACKING_URI) {
    nsCOMPtr<nsIContent> cont = do_QueryInterface(aRequest->Element());
    mDocument->AddBlockedTrackingNode(cont);
  }

  if (aRequest->IsModuleRequest() && !aRequest->mIsInline) {
    auto request = aRequest->AsModuleRequest();
    SetModuleFetchFinishedAndResumeWaitingRequests(request, aResult);
  }

  if (aRequest->mInDeferList) {
    MOZ_ASSERT_IF(aRequest->IsModuleRequest(),
                  aRequest->AsModuleRequest()->IsTopLevel());
    if (aRequest->isInList()) {
      RefPtr<ScriptLoadRequest> req = mDeferRequests.Steal(aRequest);
      FireScriptAvailable(aResult, req);
    }
  } else if (aRequest->mInAsyncList) {
    MOZ_ASSERT_IF(aRequest->IsModuleRequest(),
                  aRequest->AsModuleRequest()->IsTopLevel());
    if (aRequest->isInList()) {
      RefPtr<ScriptLoadRequest> req = mLoadingAsyncRequests.Steal(aRequest);
      FireScriptAvailable(aResult, req);
    }
  } else if (aRequest->mIsNonAsyncScriptInserted) {
    if (aRequest->isInList()) {
      RefPtr<ScriptLoadRequest> req =
        mNonAsyncExternalScriptInsertedRequests.Steal(aRequest);
      FireScriptAvailable(aResult, req);
    }
  } else if (aRequest->mIsXSLT) {
    if (aRequest->isInList()) {
      RefPtr<ScriptLoadRequest> req = mXSLTRequests.Steal(aRequest);
      FireScriptAvailable(aResult, req);
    }
  } else if (aRequest->IsModuleRequest() && !aRequest->IsPreload()) {
    ModuleLoadRequest* modReq = aRequest->AsModuleRequest();
    MOZ_ASSERT(!modReq->IsTopLevel());
    MOZ_ASSERT(!modReq->isInList());
    modReq->Cancel();
    // A single error is fired for the top level module.
  } else if (mParserBlockingRequest == aRequest) {
    MOZ_ASSERT(!aRequest->isInList());
    mParserBlockingRequest = nullptr;
    UnblockParser(aRequest);

    // Ensure that we treat aRequest->Element() as our current parser-inserted
    // script while firing onerror on it.
    MOZ_ASSERT(aRequest->Element()->GetParserCreated());
    nsCOMPtr<nsIScriptElement> oldParserInsertedScript =
      mCurrentParserInsertedScript;
    mCurrentParserInsertedScript = aRequest->Element();
    FireScriptAvailable(aResult, aRequest);
    ContinueParserAsync(aRequest);
    mCurrentParserInsertedScript = oldParserInsertedScript;
  } else if (aRequest->IsPreload()) {
    if (aRequest->IsModuleRequest()) {
      aRequest->Cancel();
    }
    if (aRequest->IsTopLevel()) {
      MOZ_ALWAYS_TRUE(mPreloads.RemoveElement(aRequest, PreloadRequestComparator()));
    }
    MOZ_ASSERT(!aRequest->isInList());
    AccumulateCategorical(LABELS_DOM_SCRIPT_PRELOAD_RESULT::LoadError);
  } else {
    // This happens for blocking requests cancelled by ParsingComplete().
    MOZ_ASSERT(aRequest->IsCanceled());
    MOZ_ASSERT(!aRequest->isInList());
  }
}

void
ScriptLoader::UnblockParser(ScriptLoadRequest* aParserBlockingRequest)
{
  aParserBlockingRequest->Element()->UnblockParser();
}

void
ScriptLoader::ContinueParserAsync(ScriptLoadRequest* aParserBlockingRequest)
{
  aParserBlockingRequest->Element()->ContinueParserAsync();
}

uint32_t
ScriptLoader::NumberOfProcessors()
{
  if (mNumberOfProcessors > 0)
    return mNumberOfProcessors;

  int32_t numProcs = PR_GetNumberOfProcessors();
  if (numProcs > 0)
    mNumberOfProcessors = numProcs;
  return mNumberOfProcessors;
}

static bool
IsInternalURIScheme(nsIURI* uri)
{
  bool isWebExt;
  if (NS_SUCCEEDED(uri->SchemeIs("moz-extension", &isWebExt)) && isWebExt) {
    return true;
  }

  bool isResource;
  if (NS_SUCCEEDED(uri->SchemeIs("resource", &isResource)) && isResource) {
    return true;
  }

  return false;
}

nsresult
ScriptLoader::PrepareLoadedRequest(ScriptLoadRequest* aRequest,
                                   nsIIncrementalStreamLoader* aLoader,
                                   nsresult aStatus)
{
  if (NS_FAILED(aStatus)) {
    return aStatus;
  }

  if (aRequest->IsCanceled()) {
    return NS_BINDING_ABORTED;
  }
  MOZ_ASSERT(aRequest->IsLoading());
  CollectScriptTelemetry(aRequest);

  // If we don't have a document, then we need to abort further
  // evaluation.
  if (!mDocument) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  // If the load returned an error page, then we need to abort
  nsCOMPtr<nsIRequest> req;
  nsresult rv = aLoader->GetRequest(getter_AddRefs(req));
  NS_ASSERTION(req, "StreamLoader's request went away prematurely");
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIHttpChannel> httpChannel = do_QueryInterface(req);
  if (httpChannel) {
    bool requestSucceeded;
    rv = httpChannel->GetRequestSucceeded(&requestSucceeded);
    if (NS_SUCCEEDED(rv) && !requestSucceeded) {
      return NS_ERROR_NOT_AVAILABLE;
    }

    nsAutoCString sourceMapURL;
    if (nsContentUtils::GetSourceMapURL(httpChannel, sourceMapURL)) {
      aRequest->mHasSourceMapURL = true;
      aRequest->mSourceMapURL = NS_ConvertUTF8toUTF16(sourceMapURL);
    }

    if (httpChannel->GetIsThirdPartyTrackingResource()) {
      aRequest->SetIsTracking();
    }
  }

  nsCOMPtr<nsIChannel> channel = do_QueryInterface(req);
  // If this load was subject to a CORS check, don't flag it with a separate
  // origin principal, so that it will treat our document's principal as the
  // origin principal.  Module loads always use CORS.
  if (!aRequest->IsModuleRequest() && aRequest->CORSMode() == CORS_NONE) {
    rv = nsContentUtils::GetSecurityManager()->
      GetChannelResultPrincipal(channel, getter_AddRefs(aRequest->mOriginPrincipal));
    NS_ENSURE_SUCCESS(rv, rv);
  }

  // This assertion could fire errorously if we ran out of memory when
  // inserting the request in the array. However it's an unlikely case
  // so if you see this assertion it is likely something else that is
  // wrong, especially if you see it more than once.
  NS_ASSERTION(mDeferRequests.Contains(aRequest) ||
               mLoadingAsyncRequests.Contains(aRequest) ||
               mNonAsyncExternalScriptInsertedRequests.Contains(aRequest) ||
               mXSLTRequests.Contains(aRequest)  ||
               (aRequest->IsModuleRequest() &&
                !aRequest->AsModuleRequest()->IsTopLevel() &&
                !aRequest->isInList()) ||
               mPreloads.Contains(aRequest, PreloadRequestComparator()) ||
               mParserBlockingRequest,
               "aRequest should be pending!");

  if (aRequest->IsModuleRequest()) {
    MOZ_ASSERT(aRequest->IsSource());
    ModuleLoadRequest* request = aRequest->AsModuleRequest();

    // When loading a module, only responses with a JavaScript MIME type are
    // acceptable.
    nsAutoCString mimeType;
    channel->GetContentType(mimeType);
    NS_ConvertUTF8toUTF16 typeString(mimeType);
    if (!nsContentUtils::IsJavascriptMIMEType(typeString)) {
      return NS_ERROR_FAILURE;
    }

    nsCOMPtr<nsIURI> uri;
    rv = channel->GetOriginalURI(getter_AddRefs(uri));
    NS_ENSURE_SUCCESS(rv, rv);

    // Fixup moz-extension: and resource: URIs, because the channel URI will
    // point to file:, which won't be allowed to load.
    if (uri && IsInternalURIScheme(uri)) {
      request->mBaseURL = uri;
    } else {
      channel->GetURI(getter_AddRefs(request->mBaseURL));
    }

    // Attempt to compile off main thread.
    bool couldCompile = false;
    rv = AttemptAsyncScriptCompile(request, &couldCompile);
    NS_ENSURE_SUCCESS(rv, rv);
    if (couldCompile) {
      return NS_OK;
    }

    // Otherwise compile it right away and start fetching descendents.
    return ProcessFetchedModuleSource(request);
  }

  // The script is now loaded and ready to run.
  aRequest->SetReady();

  // If this is currently blocking the parser, attempt to compile it off-main-thread.
  if (aRequest == mParserBlockingRequest && NumberOfProcessors() > 1) {
    MOZ_ASSERT(!aRequest->IsModuleRequest());
    bool couldCompile = false;
    nsresult rv = AttemptAsyncScriptCompile(aRequest, &couldCompile);
    NS_ENSURE_SUCCESS(rv, rv);
    if (couldCompile) {
      MOZ_ASSERT(aRequest->mProgress == ScriptLoadRequest::Progress::eCompiling,
                 "Request should be off-thread compiling now.");
      return NS_OK;
    }

    // If off-thread compile was rejected, continue with regular processing.
  }

  MaybeMoveToLoadedList(aRequest);

  return NS_OK;
}

void
ScriptLoader::ParsingComplete(bool aTerminated)
{
  if (mDeferEnabled) {
    // Have to check because we apparently get ParsingComplete
    // without BeginDeferringScripts in some cases
    mDocumentParsingDone = true;
  }
  mDeferEnabled = false;
  if (aTerminated) {
    mDeferRequests.Clear();
    mLoadingAsyncRequests.Clear();
    mLoadedAsyncRequests.Clear();
    mNonAsyncExternalScriptInsertedRequests.Clear();
    mXSLTRequests.Clear();
    if (mParserBlockingRequest) {
      mParserBlockingRequest->Cancel();
      mParserBlockingRequest = nullptr;
    }
  }

  // Have to call this even if aTerminated so we'll correctly unblock
  // onload and all.
  ProcessPendingRequests();
}

void
ScriptLoader::PreloadURI(nsIURI* aURI,
                         const nsAString& aCharset,
                         const nsAString& aType,
                         const nsAString& aCrossOrigin,
                         const nsAString& aIntegrity,
                         bool aScriptFromHead,
                         bool aAsync,
                         bool aDefer,
                         bool aNoModule,
                         const mozilla::net::ReferrerPolicy aReferrerPolicy)
{
  NS_ENSURE_TRUE_VOID(mDocument);
  // Check to see if scripts has been turned off.
  if (!mEnabled || !mDocument->IsScriptEnabled()) {
    return;
  }

  ScriptKind scriptKind = ScriptKind::eClassic;

  if (mDocument->ModuleScriptsEnabled()) {
    // Don't load nomodule scripts.
    if (aNoModule) {
      return;
    }

    static const char kASCIIWhitespace[] = "\t\n\f\r ";

    nsAutoString type(aType);
    type.Trim(kASCIIWhitespace);
    if (type.LowerCaseEqualsASCII("module")) {
      scriptKind = ScriptKind::eModule;
    }
  }

  if (scriptKind == ScriptKind::eClassic &&
      !aType.IsEmpty() && !nsContentUtils::IsJavascriptMIMEType(aType))
  {
    // Unknown type.  Don't load it.
    return;
  }

  SRIMetadata sriMetadata;
  GetSRIMetadata(aIntegrity, &sriMetadata);

  RefPtr<ScriptLoadRequest> request =
    CreateLoadRequest(scriptKind, aURI, nullptr,
                      mDocument->NodePrincipal(),
                      Element::StringToCORSMode(aCrossOrigin), sriMetadata,
                      aReferrerPolicy);
  request->mIsInline = false;
  request->mScriptFromHead = aScriptFromHead;
  request->SetScriptMode(aDefer, aAsync);

  if (LOG_ENABLED()) {
    nsAutoCString url;
    aURI->GetAsciiSpec(url);
    LOG(("ScriptLoadRequest (%p): Created preload request for %s",
         request.get(), url.get()));
  }

  nsresult rv = StartLoad(request);
  if (NS_FAILED(rv)) {
    return;
  }

  PreloadInfo* pi = mPreloads.AppendElement();
  pi->mRequest = request;
  pi->mCharset = aCharset;
}

void
ScriptLoader::AddDeferRequest(ScriptLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest->IsDeferredScript());
  MOZ_ASSERT(!aRequest->mInDeferList && !aRequest->mInAsyncList);

  aRequest->mInDeferList = true;
  mDeferRequests.AppendElement(aRequest);
  if (mDeferEnabled && aRequest == mDeferRequests.getFirst() &&
      mDocument && !mBlockingDOMContentLoaded) {
    MOZ_ASSERT(mDocument->GetReadyStateEnum() == nsIDocument::READYSTATE_LOADING);
    mBlockingDOMContentLoaded = true;
    mDocument->BlockDOMContentLoaded();
  }
}

void
ScriptLoader::AddAsyncRequest(ScriptLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest->IsAsyncScript());
  MOZ_ASSERT(!aRequest->mInDeferList && !aRequest->mInAsyncList);

  aRequest->mInAsyncList = true;
  if (aRequest->IsReadyToRun()) {
    mLoadedAsyncRequests.AppendElement(aRequest);
  } else {
    mLoadingAsyncRequests.AppendElement(aRequest);
  }
}

void
ScriptLoader::MaybeMoveToLoadedList(ScriptLoadRequest* aRequest)
{
  MOZ_ASSERT(aRequest->IsReadyToRun());

  // If it's async, move it to the loaded list.  aRequest->mInAsyncList really
  // _should_ be in a list, but the consequences if it's not are bad enough we
  // want to avoid trying to move it if it's not.
  if (aRequest->mInAsyncList) {
    MOZ_ASSERT(aRequest->isInList());
    if (aRequest->isInList()) {
      RefPtr<ScriptLoadRequest> req = mLoadingAsyncRequests.Steal(aRequest);
      mLoadedAsyncRequests.AppendElement(req);
    }
  }
}

bool
ScriptLoader::MaybeRemovedDeferRequests()
{
  if (mDeferRequests.isEmpty() && mDocument &&
      mBlockingDOMContentLoaded) {
    mBlockingDOMContentLoaded = false;
    mDocument->UnblockDOMContentLoaded();
    return true;
  }
  return false;
}

#undef TRACE_FOR_TEST
#undef TRACE_FOR_TEST_BOOL
#undef TRACE_FOR_TEST_NONE

#undef LOG

} // dom namespace
} // mozilla namespace
