/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* a presentation of a document, part 2 */

#ifndef nsIPresShell_h___
#define nsIPresShell_h___

#include "mozilla/ArenaObjectID.h"
#include "mozilla/EventForwards.h"
#include "mozilla/FlushType.h"
#include "mozilla/MemoryReporting.h"
#include "mozilla/ServoStyleSet.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/StyleSheet.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/WeakPtr.h"
#include "GeckoProfiler.h"
#include "gfxPoint.h"
#include "nsTHashtable.h"
#include "nsHashKeys.h"
#include "nsISupports.h"
#include "nsIContent.h"
#include "nsISelectionController.h"
#include "nsQueryFrame.h"
#include "nsStringFwd.h"
#include "nsCoord.h"
#include "nsColor.h"
#include "nsFrameManager.h"
#include "nsRect.h"
#include "nsRegionFwd.h"
#include "nsWeakReference.h"
#include <stdio.h> // for FILE definition
#include "nsChangeHint.h"
#include "nsRefPtrHashtable.h"
#include "nsClassHashtable.h"
#include "nsPresArena.h"
#include "nsIImageLoadingContent.h"
#include "nsMargin.h"
#include "nsFrameState.h"
#include "nsStubDocumentObserver.h"
#include "Units.h"

class gfxContext;
class nsDocShell;
class nsIDocument;
class nsIFrame;
class nsPresContext;
class nsWindowSizes;
class nsViewManager;
class nsView;
class nsIPageSequenceFrame;
class nsCanvasFrame;
class nsCaret;
namespace mozilla {
class AccessibleCaretEventHub;
class StyleSheet;
} // namespace mozilla
class nsFrameSelection;
class nsFrameManager;
class nsILayoutHistoryState;
class nsIReflowCallback;
class nsCSSFrameConstructor;
template<class E> class nsCOMArray;
class AutoWeakFrame;
class WeakFrame;
class nsIScrollableFrame;
class nsDisplayList;
class nsDisplayListBuilder;
class nsPIDOMWindowOuter;
struct nsPoint;
class nsINode;
struct nsRect;
class nsRegion;
class nsRefreshDriver;
class nsARefreshObserver;
class nsAPostRefreshObserver;
#ifdef ACCESSIBILITY
class nsAccessibilityService;
namespace mozilla {
namespace a11y {
class DocAccessible;
} // namespace a11y
} // namespace mozilla
#endif
class nsITimer;

namespace mozilla {
class EventStates;

namespace dom {
class Element;
class Event;
class HTMLSlotElement;
class Touch;
class Selection;
class ShadowRoot;
} // namespace dom

namespace layers {
class LayerManager;
} // namespace layers

namespace gfx {
class SourceSurface;
} // namespace gfx
} // namespace mozilla

// Flags to pass to SetCapturingContent
//
// when assigning capture, ignore whether capture is allowed or not
#define CAPTURE_IGNOREALLOWED 1
// true if events should be targeted at the capturing content or its children
#define CAPTURE_RETARGETTOELEMENT 2
// true if the current capture wants drags to be prevented
#define CAPTURE_PREVENTDRAG 4
// true when the mouse is pointer locked, and events are sent to locked element
#define CAPTURE_POINTERLOCK 8

typedef struct CapturingContentInfo {
  // capture should only be allowed during a mousedown event
  bool mAllowed;
  bool mPointerLock;
  bool mRetargetToElement;
  bool mPreventDrag;
  mozilla::StaticRefPtr<nsIContent> mContent;
} CapturingContentInfo;

// b7b89561-4f03-44b3-9afa-b47e7f313ffb
#define NS_IPRESSHELL_IID \
  { 0xb7b89561, 0x4f03, 0x44b3, \
    { 0x9a, 0xfa, 0xb4, 0x7e, 0x7f, 0x31, 0x3f, 0xfb } }

// debug VerifyReflow flags
#define VERIFY_REFLOW_ON                    0x01
#define VERIFY_REFLOW_NOISY                 0x02
#define VERIFY_REFLOW_ALL                   0x04
#define VERIFY_REFLOW_DUMP_COMMANDS         0x08
#define VERIFY_REFLOW_NOISY_RC              0x10
#define VERIFY_REFLOW_REALLY_NOISY_RC       0x20
#define VERIFY_REFLOW_DURING_RESIZE_REFLOW  0x40

#undef NOISY_INTERRUPTIBLE_REFLOW

enum nsRectVisibility {
  nsRectVisibility_kVisible,
  nsRectVisibility_kAboveViewport,
  nsRectVisibility_kBelowViewport,
  nsRectVisibility_kLeftOfViewport,
  nsRectVisibility_kRightOfViewport
};

/**
 * Presentation shell interface. Presentation shells are the
 * controlling point for managing the presentation of a document. The
 * presentation shell holds a live reference to the document, the
 * presentation context, the style manager, the style set and the root
 * frame. <p>
 *
 * When this object is Release'd, it will release the document, the
 * presentation context, the style manager, the style set and the root
 * frame.
 */

class nsIPresShell : public nsStubDocumentObserver
{
public:
  NS_DECLARE_STATIC_IID_ACCESSOR(NS_IPRESSHELL_IID)

protected:
  typedef mozilla::layers::LayerManager LayerManager;
  typedef mozilla::gfx::SourceSurface SourceSurface;

  enum eRenderFlag {
    STATE_IGNORING_VIEWPORT_SCROLLING = 0x1,
    STATE_DRAWWINDOW_NOT_FLUSHING = 0x2
  };
  typedef uint8_t RenderFlags; // for storing the above flags

public:
  nsIPresShell();

  /**
   * All callers are responsible for calling |Destroy| after calling
   * |EndObservingDocument|.  It needs to be separate only because form
   * controls incorrectly store their data in the frames rather than the
   * content model and printing calls |EndObservingDocument| multiple
   * times to make form controls behave nicely when printed.
   */
  virtual void Destroy() = 0;

  bool IsDestroying() { return mIsDestroying; }

  /**
   * All frames owned by the shell are allocated from an arena.  They
   * are also recycled using free lists.  Separate free lists are
   * maintained for each frame type (aID), which must always correspond
   * to the same aSize value.  AllocateFrame is infallible and will abort
   * on out-of-memory.
   */
  void* AllocateFrame(nsQueryFrame::FrameIID aID, size_t aSize)
  {
    void* result = mFrameArena.AllocateByFrameID(aID, aSize);
    RecordAlloc(result);
    return result;
  }

  void FreeFrame(nsQueryFrame::FrameIID aID, void* aPtr)
  {
    RecordFree(aPtr);
    if (!mIsDestroying)
      mFrameArena.FreeByFrameID(aID, aPtr);
  }

  /**
   * This is for allocating other types of objects (not frames).  Separate free
   * lists are maintained for each type (aID), which must always correspond to
   * the same aSize value.  AllocateByObjectID is infallible and will abort on
   * out-of-memory.
   */
  void* AllocateByObjectID(mozilla::ArenaObjectID aID, size_t aSize)
  {
    void* result = mFrameArena.AllocateByObjectID(aID, aSize);
    RecordAlloc(result);
    return result;
  }

  void FreeByObjectID(mozilla::ArenaObjectID aID, void* aPtr)
  {
    RecordFree(aPtr);
    if (!mIsDestroying)
      mFrameArena.FreeByObjectID(aID, aPtr);
  }

  template<typename T>
  void RegisterArenaRefPtr(mozilla::ArenaRefPtr<T>* aPtr)
  {
    mFrameArena.RegisterArenaRefPtr(aPtr);
  }

  template<typename T>
  void DeregisterArenaRefPtr(mozilla::ArenaRefPtr<T>* aPtr)
  {
    mFrameArena.DeregisterArenaRefPtr(aPtr);
  }

  void ClearArenaRefPtrs(mozilla::ArenaObjectID aObjectID)
  {
    mFrameArena.ClearArenaRefPtrs(aObjectID);
  }

  nsIDocument* GetDocument() const { return mDocument; }

  nsPresContext* GetPresContext() const { return mPresContext; }

  nsViewManager* GetViewManager() const { return mViewManager; }

  nsRefreshDriver* GetRefreshDriver() const;

#ifdef ACCESSIBILITY
  /**
   * Return the document accessible for this pres shell if there is one.
   */
  mozilla::a11y::DocAccessible* GetDocAccessible() const
  {
    return mDocAccessible;
  }

  /**
   * Set the document accessible for this pres shell.
   */
  void SetDocAccessible(mozilla::a11y::DocAccessible* aDocAccessible)
  {
    mDocAccessible = aDocAccessible;
  }
#endif

  mozilla::ServoStyleSet* StyleSet() const { return mStyleSet.get(); }

  nsCSSFrameConstructor* FrameConstructor() const { return mFrameConstructor; }

  /* Enable/disable author style level. Disabling author style disables the entire
   * author level of the cascade, including the HTML preshint level.
   */
  // XXX these could easily be inlined, but there is a circular #include
  // problem with nsStyleSet.
  void SetAuthorStyleDisabled(bool aDisabled);
  bool GetAuthorStyleDisabled() const;

  /**
   * Needs to be called any time the applicable style can has changed, in order
   * to schedule a style flush and setup all the relevant state.
   */
  void ApplicableStylesChanged();

  /**
   * Update the style set somehow to take into account changed prefs which
   * affect document styling.
   */
  virtual void UpdatePreferenceStyles() = 0;

  /**
   * FrameSelection will return the Frame based selection API.
   * You cannot go back and forth anymore with QI between nsIDOM sel and
   * nsIFrame sel.
   */
  already_AddRefed<nsFrameSelection> FrameSelection();

  /**
   * ConstFrameSelection returns an object which methods are safe to use for
   * example in nsIFrame code.
   */
  const nsFrameSelection* ConstFrameSelection() const { return mSelection; }

  // Start receiving notifications from our document. If called after Destroy,
  // this will be ignored.
  void BeginObservingDocument();

  // Stop receiving notifications from our document. If called after Destroy,
  // this will be ignored.
  void EndObservingDocument();

  bool IsObservingDocument() const { return mIsObservingDocument; }

  /**
   * Return whether Initialize() was previously called.
   */
  bool DidInitialize() const { return mDidInitialize; }

  /**
   * Perform initialization. Constructs the frame for the root content
   * object and then enqueues a reflow of the frame model.
   *
   * Callers of this method must hold a reference to this shell that
   * is guaranteed to survive through arbitrary script execution.
   * Calling Initialize can execute arbitrary script.
   */
  virtual nsresult Initialize() = 0;

  enum class ResizeReflowOptions : uint32_t {
    // the resulting BSize should be exactly as given
    eBSizeExact,
    // the resulting BSize can be less than the given one, producing
    // shrink-to-fit sizing in the block dimension
    eBSizeLimit
  };
  /**
   * Reflow the frame model into a new width and height.  The
   * coordinates for aWidth and aHeight must be in standard nscoord's.
   */
  virtual nsresult ResizeReflow(nscoord aWidth, nscoord aHeight,
                                nscoord aOldWidth = 0, nscoord aOldHeight = 0,
                                ResizeReflowOptions aOptions =
                                  ResizeReflowOptions::eBSizeExact) = 0;
  /**
   * Do the same thing as ResizeReflow but even if ResizeReflowOverride was
   * called previously.
   */
  virtual nsresult ResizeReflowIgnoreOverride(
                     nscoord aWidth, nscoord aHeight,
                     nscoord aOldWidth, nscoord aOldHeight,
                     ResizeReflowOptions aOptions =
                       ResizeReflowOptions::eBSizeExact) = 0;

  /**
   * Returns true if ResizeReflowOverride has been called.
   */
  virtual bool GetIsViewportOverridden() = 0;

  /**
   * Return true if the presshell expects layout flush.
   */
  virtual bool IsLayoutFlushObserver() = 0;

  /**
   * Called when document load completes.
   */
  virtual void LoadComplete() = 0;

  /**
   * This calls through to the frame manager to get the root frame.
   */
  nsIFrame* GetRootFrame() const {
    return mFrameManager->GetRootFrame();
  }

  /*
   * Get root scroll frame from FrameManager()->GetRootFrame().
   */
  nsIFrame* GetRootScrollFrame() const;

  /*
   * The same as GetRootScrollFrame, but returns an nsIScrollableFrame
   */
  nsIScrollableFrame* GetRootScrollFrameAsScrollable() const;

  /**
   * Get the current focused content or DOM selection that should be the
   * target for scrolling.
   */
  already_AddRefed<nsIContent> GetContentForScrolling() const;

  /**
   * Get the DOM selection that should be the target for scrolling, if there
   * is no focused content.
   */
  already_AddRefed<nsIContent> GetSelectedContentForScrolling() const;

  /**
   * Gets nearest scrollable frame from the specified content node. The frame
   * is scrollable with overflow:scroll or overflow:auto in some direction when
   * aDirection is eEither.  Otherwise, this returns a nearest frame that is
   * scrollable in the specified direction.
   */
  enum ScrollDirection { eHorizontal, eVertical, eEither };
  nsIScrollableFrame* GetScrollableFrameToScrollForContent(
                         nsIContent* aContent,
                         ScrollDirection aDirection);

  /**
   * Gets nearest scrollable frame from current focused content or DOM
   * selection if there is no focused content. The frame is scrollable with
   * overflow:scroll or overflow:auto in some direction when aDirection is
   * eEither.  Otherwise, this returns a nearest frame that is scrollable in
   * the specified direction.
   */
  nsIScrollableFrame* GetScrollableFrameToScroll(ScrollDirection aDirection);

  /**
   * Gets nearest ancestor scrollable frame from aFrame.  The frame is
   * scrollable with overflow:scroll or overflow:auto in some direction when
   * aDirection is eEither.  Otherwise, this returns a nearest frame that is
   * scrollable in the specified direction.
   */
  nsIScrollableFrame* GetNearestScrollableFrame(nsIFrame* aFrame,
                                                ScrollDirection aDirection);

  /**
   * Returns the page sequence frame associated with the frame hierarchy.
   * Returns nullptr if not a paginated view.
   */
  virtual nsIPageSequenceFrame* GetPageSequenceFrame() const = 0;

  /**
  * Returns the canvas frame associated with the frame hierarchy.
  * Returns nullptr if is XUL document.
  */
  virtual nsCanvasFrame* GetCanvasFrame() const = 0;

  /**
   * Tell the pres shell that a frame needs to be marked dirty and needs
   * Reflow.  It's OK if this is an ancestor of the frame needing reflow as
   * long as the ancestor chain between them doesn't cross a reflow root.
   *
   * The bit to add should be NS_FRAME_IS_DIRTY, NS_FRAME_HAS_DIRTY_CHILDREN
   * or nsFrameState(0); passing 0 means that dirty bits won't be set on the
   * frame or its ancestors/descendants, but that intrinsic widths will still
   * be marked dirty.  Passing aIntrinsicDirty = eResize and aBitToAdd = 0
   * would result in no work being done, so don't do that.
   */
  enum IntrinsicDirty {
    // XXXldb eResize should be renamed
    eResize,     // don't mark any intrinsic widths dirty
    eTreeChange, // mark intrinsic widths dirty on aFrame and its ancestors
    eStyleChange // Do eTreeChange, plus all of aFrame's descendants
  };
  enum ReflowRootHandling {
    ePositionOrSizeChange, // aFrame is changing position or size
    eNoPositionOrSizeChange, // ... NOT changing ...
    eInferFromBitToAdd // is changing iff (aBitToAdd == NS_FRAME_IS_DIRTY)

    // Note:  With eStyleChange, these can also apply to out-of-flows
    // in addition to aFrame.
  };
  virtual void FrameNeedsReflow(nsIFrame *aFrame,
                                IntrinsicDirty aIntrinsicDirty,
                                nsFrameState aBitToAdd,
                                ReflowRootHandling aRootHandling =
                                  eInferFromBitToAdd) = 0;

  /**
   * Calls FrameNeedsReflow on all fixed position children of the root frame.
   */
  virtual void MarkFixedFramesForReflow(IntrinsicDirty aIntrinsicDirty);

  /**
   * Tell the presshell that the given frame's reflow was interrupted.  This
   * will mark as having dirty children a path from the given frame (inclusive)
   * to the nearest ancestor with a dirty subtree, or to the reflow root
   * currently being reflowed if no such ancestor exists (inclusive).  This is
   * to be done immediately after reflow of the current reflow root completes.
   * This method must only be called during reflow, and the frame it's being
   * called on must be in the process of being reflowed when it's called.  This
   * method doesn't mark any intrinsic widths dirty and doesn't add any bits
   * other than NS_FRAME_HAS_DIRTY_CHILDREN.
   */
  virtual void FrameNeedsToContinueReflow(nsIFrame *aFrame) = 0;

  virtual void CancelAllPendingReflows() = 0;

  virtual void NotifyCounterStylesAreDirty() = 0;

  bool FrameIsAncestorOfDirtyRoot(nsIFrame* aFrame) const;

  /**
   * Destroy the frames for aElement, and reconstruct them asynchronously if
   * needed.
   *
   * Note that this may destroy frames for an ancestor instead.
   */
  void DestroyFramesForAndRestyle(mozilla::dom::Element* aElement);

  /**
   * Handles all the layout stuff needed when the slot assignment for an element
   * is about to change.
   *
   * Only called when the slot attribute of the element changes, the rest of
   * the changes should be handled in ShadowRoot.
   */
  void SlotAssignmentWillChange(mozilla::dom::Element& aElement,
                                mozilla::dom::HTMLSlotElement* aOldSlot,
                                mozilla::dom::HTMLSlotElement* aNewSlot);

  void PostRecreateFramesFor(mozilla::dom::Element* aElement);
  void RestyleForAnimation(mozilla::dom::Element* aElement,
                           nsRestyleHint aHint);

  // ShadowRoot has APIs that can change styles. This notifies the shell that
  // stlyes applicable in the shadow tree have potentially changed.
  void RecordShadowStyleChange(mozilla::dom::ShadowRoot& aShadowRoot);


  /**
   * Determine if it is safe to flush all pending notifications.
   */
  bool IsSafeToFlush() const;

  /**
   * Informs the document's FontFaceSet that the refresh driver ticked,
   * flushing style and layout.
   */
  void NotifyFontFaceSetOnRefresh();

  /**
   * Flush pending notifications of the type specified.  This method
   * will not affect the content model; it'll just affect style and
   * frames. Callers that actually want up-to-date presentation (other
   * than the document itself) should probably be calling
   * nsIDocument::FlushPendingNotifications.
   *
   * This method can execute script, which can destroy this presshell object
   * unless someone is holding a reference to it on the stack.  The presshell
   * itself will ensure it lives up until the method returns, but callers who
   * plan to use the presshell after this call should hold a strong ref
   * themselves!
   *
   * @param aType the type of notifications to flush
   */
  void FlushPendingNotifications(mozilla::FlushType aType)
  {
    if (!NeedFlush(aType)) {
      return;
    }

    DoFlushPendingNotifications(aType);
  }

  void FlushPendingNotifications(mozilla::ChangesToFlush aType)
  {
    if (!NeedFlush(aType.mFlushType)) {
      return;
    }

    DoFlushPendingNotifications(aType);
  }

protected:
  /**
   * Implementation methods for FlushPendingNotifications.
   */
  virtual void DoFlushPendingNotifications(mozilla::FlushType aType) = 0;
  virtual void DoFlushPendingNotifications(mozilla::ChangesToFlush aType) = 0;

public:
  /**
   * Whether we might need a flush for the given flush type.  If this
   * function returns false, we definitely don't need to flush.
   *
   * @param aFlushType The flush type to check.  This must be
   *   >= FlushType::Style.  This also returns true if a throttled
   *   animation flush is required.
   */
  bool NeedFlush(mozilla::FlushType aType) const
  {
    // We check mInFlush to handle re-entrant calls to FlushPendingNotifications
    // by reporting that we always need a flush in that case.  Otherwise,
    // we could end up missing needed flushes, since we clear the mNeedXXXFlush
    // flags at the top of FlushPendingNotifications.
    MOZ_ASSERT(aType >= mozilla::FlushType::Style);
    return mNeedStyleFlush ||
           (mNeedLayoutFlush &&
            aType >= mozilla::FlushType::InterruptibleLayout) ||
           aType >= mozilla::FlushType::Display ||
           mNeedThrottledAnimationFlush ||
           mInFlush;
  }

  inline void EnsureStyleFlush();
  inline void SetNeedStyleFlush();
  inline void SetNeedLayoutFlush();
  inline void SetNeedThrottledAnimationFlush();

  // Removes ourself from the list of layout / style / and resize refresh driver
  // observers.
  //
  // Right now this is only used for documents in the BFCache, so if you want to
  // use this for anything else you need to ensure we don't end up in those
  // lists after calling this, but before calling StartObservingRefreshDriver
  // again.
  //
  // That is handled by the mDocument->GetBFCacheEntry checks in
  // DoObserve*Flushes functions, though that could conceivably become a boolean
  // member in the shell if needed.
  //
  // Callers are responsible of manually calling StartObservingRefreshDriver
  // again.
  void StopObservingRefreshDriver();
  void StartObservingRefreshDriver();

  bool ObservingStyleFlushes() const { return mObservingStyleFlushes; }
  bool ObservingLayoutFlushes() const { return mObservingLayoutFlushes; }

  void ObserveStyleFlushes()
  {
    if (!ObservingStyleFlushes())
      DoObserveStyleFlushes();
  }

  bool NeedStyleFlush() const { return mNeedStyleFlush; }
  /**
   * Returns true if we might need to flush layout, even if we haven't scheduled
   * one yet (as opposed to HasPendingReflow, which returns true if a flush is
   * scheduled or will soon be scheduled).
   */
  bool NeedLayoutFlush() const { return mNeedLayoutFlush; }

  /**
   * Callbacks will be called even if reflow itself fails for
   * some reason.
   */
  virtual nsresult PostReflowCallback(nsIReflowCallback* aCallback) = 0;
  virtual void CancelReflowCallback(nsIReflowCallback* aCallback) = 0;

  virtual void ClearFrameRefs(nsIFrame* aFrame) = 0;

  /**
   * Get a reference rendering context. This is a context that should not
   * be rendered to, but is suitable for measuring text and performing
   * other non-rendering operations. Guaranteed to return non-null.
   */
  virtual already_AddRefed<gfxContext> CreateReferenceRenderingContext() = 0;

  /**
   * Informs the pres shell that the document is now at the anchor with
   * the given name.  If |aScroll| is true, scrolls the view of the
   * document so that the anchor with the specified name is displayed at
   * the top of the window.  If |aAnchorName| is empty, then this informs
   * the pres shell that there is no current target, and |aScroll| must
   * be false.  If |aAdditionalScrollFlags| is nsIPresShell::SCROLL_SMOOTH_AUTO
   * and |aScroll| is true, the scrolling may be performed with an animation.
   */
  virtual nsresult GoToAnchor(const nsAString& aAnchorName, bool aScroll,
                              uint32_t aAdditionalScrollFlags = 0) = 0;

  /**
   * Tells the presshell to scroll again to the last anchor scrolled to by
   * GoToAnchor, if any. This scroll only happens if the scroll
   * position has not changed since the last GoToAnchor. This is called
   * by nsDocumentViewer::LoadComplete. This clears the last anchor
   * scrolled to by GoToAnchor (we don't want to keep it alive if it's
   * removed from the DOM), so don't call this more than once.
   */
  virtual nsresult ScrollToAnchor() = 0;

  enum {
    SCROLL_TOP     = 0,
    SCROLL_BOTTOM  = 100,
    SCROLL_LEFT    = 0,
    SCROLL_RIGHT   = 100,
    SCROLL_CENTER  = 50,
    SCROLL_MINIMUM = -1
  };

  enum WhenToScroll {
    SCROLL_ALWAYS,
    SCROLL_IF_NOT_VISIBLE,
    SCROLL_IF_NOT_FULLY_VISIBLE
  };
  typedef struct ScrollAxis {
    int16_t mWhereToScroll;
    WhenToScroll mWhenToScroll : 8;
    bool mOnlyIfPerceivedScrollableDirection : 1;
  /**
   * @param aWhere: Either a percentage or a special value.
   *                nsIPresShell defines:
   *                * (Default) SCROLL_MINIMUM = -1: The visible area is scrolled
   *                the minimum amount to show as much as possible of the frame.
   *                This won't hide any initially visible part of the frame.
   *                * SCROLL_TOP = 0: The frame's upper edge is aligned with the
   *                top edge of the visible area.
   *                * SCROLL_BOTTOM = 100: The frame's bottom edge is aligned
   *                with the bottom edge of the visible area.
   *                * SCROLL_LEFT = 0: The frame's left edge is aligned with the
   *                left edge of the visible area.
   *                * SCROLL_RIGHT = 100: The frame's right edge is aligned with
   *                the right edge of the visible area.
   *                * SCROLL_CENTER = 50: The frame is centered along the axis
   *                the ScrollAxis is used for.
   *
   *                Other values are treated as a percentage, and the point
   *                "percent" down the frame is placed at the point "percent"
   *                down the visible area.
   * @param aWhen:
   *                * (Default) SCROLL_IF_NOT_FULLY_VISIBLE: Move the frame only
   *                if it is not fully visible (including if it's not visible
   *                at all). Note that in this case if the frame is too large to
   *                fit in view, it will only be scrolled if more of it can fit
   *                than is already in view.
   *                * SCROLL_IF_NOT_VISIBLE: Move the frame only if none of it
   *                is visible.
   *                * SCROLL_ALWAYS: Move the frame regardless of its current
   *                visibility.
   * @param aOnlyIfPerceivedScrollableDirection:
   *                If the direction is not a perceived scrollable direction (i.e.
   *                no scrollbar showing and less than one device pixel of
   *                scrollable distance), don't scroll. Defaults to false.
   */
    explicit ScrollAxis(int16_t aWhere = SCROLL_MINIMUM,
                        WhenToScroll aWhen = SCROLL_IF_NOT_FULLY_VISIBLE,
                        bool aOnlyIfPerceivedScrollableDirection = false) :
      mWhereToScroll(aWhere), mWhenToScroll(aWhen),
      mOnlyIfPerceivedScrollableDirection(aOnlyIfPerceivedScrollableDirection)
    {}
  } ScrollAxis;
  /**
   * Scrolls the view of the document so that the primary frame of the content
   * is displayed in the window. Layout is flushed before scrolling.
   *
   * @param aContent  The content object of which primary frame should be
   *                  scrolled into view.
   * @param aVertical How to align the frame vertically and when to do so.
   *                  This is a ScrollAxis of Where and When.
   * @param aHorizontal How to align the frame horizontally and when to do so.
   *                  This is a ScrollAxis of Where and When.
   * @param aFlags    If SCROLL_FIRST_ANCESTOR_ONLY is set, only the nearest
   *                  scrollable ancestor is scrolled, otherwise all
   *                  scrollable ancestors may be scrolled if necessary.
   *                  If SCROLL_OVERFLOW_HIDDEN is set then we may scroll in a
   *                  direction even if overflow:hidden is specified in that
   *                  direction; otherwise we will not scroll in that direction
   *                  when overflow:hidden is set for that direction.
   *                  If SCROLL_NO_PARENT_FRAMES is set then we only scroll
   *                  nodes in this document, not in any parent documents which
   *                  contain this document in a iframe or the like.
   *                  If SCROLL_SMOOTH is set and CSSOM-VIEW scroll-behavior
   *                  is enabled, we will scroll smoothly using
   *                  nsIScrollableFrame::ScrollMode::SMOOTH_MSD; otherwise,
   *                  nsIScrollableFrame::ScrollMode::INSTANT will be used.
   *                  If SCROLL_SMOOTH_AUTO is set, the CSSOM-View
   *                  scroll-behavior attribute is set to 'smooth' on the
   *                  scroll frame, and CSSOM-VIEW scroll-behavior is enabled,
   *                  we will scroll smoothly using
   *                  nsIScrollableFrame::ScrollMode::SMOOTH_MSD; otherwise,
   *                  nsIScrollableFrame::ScrollMode::INSTANT will be used.
   */
  virtual nsresult ScrollContentIntoView(nsIContent* aContent,
                                                     ScrollAxis  aVertical,
                                                     ScrollAxis  aHorizontal,
                                                     uint32_t    aFlags) = 0;

  enum {
    SCROLL_FIRST_ANCESTOR_ONLY = 0x01,
    SCROLL_OVERFLOW_HIDDEN = 0x02,
    SCROLL_NO_PARENT_FRAMES = 0x04,
    SCROLL_SMOOTH = 0x08,
    SCROLL_SMOOTH_AUTO = 0x10
  };
  /**
   * Scrolls the view of the document so that the given area of a frame
   * is visible, if possible. Layout is not flushed before scrolling.
   *
   * @param aRect relative to aFrame
   * @param aVertical see ScrollContentIntoView and ScrollAxis
   * @param aHorizontal see ScrollContentIntoView and ScrollAxis
   * @param aFlags if SCROLL_FIRST_ANCESTOR_ONLY is set, only the
   * nearest scrollable ancestor is scrolled, otherwise all
   * scrollable ancestors may be scrolled if necessary
   * if SCROLL_OVERFLOW_HIDDEN is set then we may scroll in a direction
   * even if overflow:hidden is specified in that direction; otherwise
   * we will not scroll in that direction when overflow:hidden is
   * set for that direction
   * If SCROLL_NO_PARENT_FRAMES is set then we only scroll
   * nodes in this document, not in any parent documents which
   * contain this document in a iframe or the like.
   * @return true if any scrolling happened, false if no scrolling happened
   */
  virtual bool ScrollFrameRectIntoView(nsIFrame*     aFrame,
                                       const nsRect& aRect,
                                       ScrollAxis    aVertical,
                                       ScrollAxis    aHorizontal,
                                       uint32_t      aFlags) = 0;

  /**
   * Determine if a rectangle specified in the frame's coordinate system
   * intersects "enough" with the viewport to be considered visible. This
   * is not a strict test against the viewport -- it's a test against
   * the intersection of the viewport and the frame's ancestor scrollable
   * frames. If it doesn't intersect enough, return a value indicating
   * which direction the frame's topmost ancestor scrollable frame would
   * need to be scrolled to bring the frame into view.
   * @param aFrame frame that aRect coordinates are specified relative to
   * @param aRect rectangle in twips to test for visibility
   * @param aMinTwips is the minimum distance in from the edge of the
   *                  visible area that an object must be to be counted
   *                  visible
   * @return nsRectVisibility_kVisible if the rect is visible
   *         nsRectVisibility_kAboveViewport
   *         nsRectVisibility_kBelowViewport
   *         nsRectVisibility_kLeftOfViewport
   *         nsRectVisibility_kRightOfViewport rectangle is outside the
   *         topmost ancestor scrollable frame in the specified direction
   */
  virtual nsRectVisibility GetRectVisibility(nsIFrame *aFrame,
                                             const nsRect &aRect,
                                             nscoord aMinTwips) const = 0;

  /**
   * Suppress notification of the frame manager that frames are
   * being destroyed.
   */
  virtual void SetIgnoreFrameDestruction(bool aIgnore) = 0;

  /**
   * Notification sent by a frame informing the pres shell that it is about to
   * be destroyed.
   * This allows any outstanding references to the frame to be cleaned up
   */
  virtual void NotifyDestroyingFrame(nsIFrame* aFrame) = 0;

  /**
   * Get the AccessibleCaretEventHub, if it exists. AddRefs it.
   */
  virtual already_AddRefed<mozilla::AccessibleCaretEventHub> GetAccessibleCaretEventHub() const = 0;

  /**
   * Get the caret, if it exists. AddRefs it.
   */
  virtual already_AddRefed<nsCaret> GetCaret() const = 0;

  /**
   * Set the current caret to a new caret. To undo this, call RestoreCaret.
   */
  virtual void SetCaret(nsCaret *aNewCaret) = 0;

  /**
   * Restore the caret to the original caret that this pres shell was created
   * with.
   */
  virtual void RestoreCaret() = 0;

  /**
   * Should the images have borders etc.  Actual visual effects are determined
   * by the frames.  Visual effects may not effect layout, only display.
   * Takes effect on next repaint, does not force a repaint itself.
   *
   * @param aInEnable  if true, visual selection effects are enabled
   *                   if false visual selection effects are disabled
   */
  NS_IMETHOD SetSelectionFlags(int16_t aInEnable) = 0;

  /**
    * Gets the current state of non text selection effects
    * @return   current state of non text selection,
    *           as set by SetDisplayNonTextSelection
    */
  int16_t GetSelectionFlags() const { return mSelectionFlags; }

  virtual mozilla::dom::Selection*
    GetCurrentSelection(mozilla::SelectionType aSelectionType) = 0;

  /**
   * Gets a selection controller for the focused content in the DOM window
   * for mDocument.
   *
   * @param aFocusedContent     If there is focused content in the DOM window,
   *                            the focused content will be returned.  This may
   *                            be nullptr if it's not necessary.
   * @return                    A selection controller for focused content.
   *                            E.g., if an <input> element has focus, returns
   *                            the independent selection controller of it.
   *                            If the DOM window does not have focused content
   *                            (similar to Document.activeElement), returns
   *                            nullptr.
   */
  virtual already_AddRefed<nsISelectionController>
            GetSelectionControllerForFocusedContent(
              nsIContent** aFocusedContent = nullptr) = 0;

  /**
    * Interface to dispatch events via the presshell
    * @note The caller must have a strong reference to the PresShell.
    */
  virtual nsresult HandleEventWithTarget(
                                 mozilla::WidgetEvent* aEvent,
                                 nsIFrame* aFrame,
                                 nsIContent* aContent,
                                 nsEventStatus* aStatus,
                                 bool aIsHandlingNativeEvent = false,
                                 nsIContent** aTargetContent = nullptr,
                                 nsIContent* aOverrideClickTarget = nullptr) = 0;

  /**
   * Dispatch event to content only (NOT full processing)
   * @note The caller must have a strong reference to the PresShell.
   */
  virtual nsresult HandleDOMEventWithTarget(
                                 nsIContent* aTargetContent,
                                 mozilla::WidgetEvent* aEvent,
                                 nsEventStatus* aStatus) = 0;

  /**
   * Dispatch event to content only (NOT full processing)
   * @note The caller must have a strong reference to the PresShell.
   */
  virtual nsresult HandleDOMEventWithTarget(nsIContent* aTargetContent,
                                            mozilla::dom::Event* aEvent,
                                            nsEventStatus* aStatus) = 0;

  /**
   * Return whether or not the event is valid to be dispatched
   */
  virtual bool CanDispatchEvent(
      const mozilla::WidgetGUIEvent* aEvent = nullptr) const = 0;

  /**
    * Gets the current target event frame from the PresShell
    */
  virtual nsIFrame* GetEventTargetFrame() = 0;

  /**
    * Gets the current target event frame from the PresShell
    */
  virtual already_AddRefed<nsIContent> GetEventTargetContent(
                                                     mozilla::WidgetEvent* aEvent) = 0;

  /**
   * Get and set the history state for the current document
   */

  virtual nsresult CaptureHistoryState(nsILayoutHistoryState** aLayoutHistoryState) = 0;

  /**
   * Determine if reflow is currently locked
   * returns true if reflow is locked, false otherwise
   */
  bool IsReflowLocked() const { return mIsReflowing; }

  /**
   * Called to find out if painting is suppressed for this presshell.  If it is suppressd,
   * we don't allow the painting of any layer but the background, and we don't
   * recur into our children.
   */
  bool IsPaintingSuppressed() const { return mPaintingSuppressed; }

  /**
   * Pause painting by freezing the refresh driver of this and all parent
   * presentations. This may not have the desired effect if this pres shell
   * has its own refresh driver.
   */
  virtual void PausePainting() = 0;

  /**
   * Resume painting by thawing the refresh driver of this and all parent
   * presentations. This may not have the desired effect if this pres shell
   * has its own refresh driver.
   */
  virtual void ResumePainting() = 0;

  /**
   * Unsuppress painting.
   */
  virtual void UnsuppressPainting() = 0;

  /**
   * Get the set of agent style sheets for this presentation
   */
  virtual nsresult GetAgentStyleSheets(
      nsTArray<RefPtr<mozilla::StyleSheet>>& aSheets) = 0;

  /**
   * Replace the set of agent style sheets
   */
  virtual nsresult SetAgentStyleSheets(
      const nsTArray<RefPtr<mozilla::StyleSheet>>& aSheets) = 0;

  /**
   * Add an override style sheet for this presentation
   */
  virtual nsresult AddOverrideStyleSheet(mozilla::StyleSheet* aSheet) = 0;

  /**
   * Remove an override style sheet
   */
  virtual nsresult RemoveOverrideStyleSheet(mozilla::StyleSheet* aSheet) = 0;

  /**
   * Reconstruct frames for all elements in the document
   */
  virtual void ReconstructFrames() = 0;

  /**
   * Notify that a content node's state has changed
   */
  virtual void ContentStateChanged(nsIDocument* aDocument,
                                   nsIContent* aContent,
                                   mozilla::EventStates aStateMask) override = 0;

  /**
   * See if reflow verification is enabled. To enable reflow verification add
   * "verifyreflow:1" to your MOZ_LOG environment variable (any non-zero
   * debug level will work). Or, call SetVerifyReflowEnable with true.
   */
  static bool GetVerifyReflowEnable();

  /**
   * Set the verify-reflow enable flag.
   */
  static void SetVerifyReflowEnable(bool aEnabled);

  virtual nsIFrame* GetAbsoluteContainingBlock(nsIFrame* aFrame);

#ifdef MOZ_REFLOW_PERF
  virtual void DumpReflows() = 0;
  virtual void CountReflows(const char * aName, nsIFrame * aFrame) = 0;
  virtual void PaintCount(const char * aName,
                                      gfxContext* aRenderingContext,
                                      nsPresContext * aPresContext,
                                      nsIFrame * aFrame,
                                      const nsPoint& aOffset,
                                      uint32_t aColor) = 0;
  virtual void SetPaintFrameCount(bool aOn) = 0;
  virtual bool IsPaintingFrameCounts() = 0;
#endif

#ifdef DEBUG
  // Debugging hooks
  virtual void ListComputedStyles(FILE *out, int32_t aIndent = 0) = 0;

  virtual void ListStyleSheets(FILE *out, int32_t aIndent = 0) = 0;
#endif

#ifdef ACCESSIBILITY
  /**
   * Return true if accessibility is active.
   */
  static bool IsAccessibilityActive();

  /**
   * Return accessibility service if accessibility is active.
   */
  static nsAccessibilityService* AccService();
#endif

  /**
   * Stop all active elements (plugins and the caret) in this presentation and
   * in the presentations of subdocuments.  Resets painting to a suppressed state.
   * XXX this should include image animations
   */
  virtual void Freeze() = 0;
  bool IsFrozen() { return mFrozen; }

  /**
   * Restarts active elements (plugins) in this presentation and in the
   * presentations of subdocuments, then do a full invalidate of the content area.
   */
  virtual void Thaw() = 0;

  virtual void FireOrClearDelayedEvents(bool aFireEvents) = 0;

  /**
   * When this shell is disconnected from its containing docshell, we
   * lose our container pointer.  However, we'd still like to be able to target
   * user events at the docshell's parent.  This pointer allows us to do that.
   * It should not be used for any other purpose.
   */
  void SetForwardingContainer(const mozilla::WeakPtr<nsDocShell> &aContainer);

  /**
   * Render the document into an arbitrary gfxContext
   * Designed for getting a picture of a document or a piece of a document
   * Note that callers will generally want to call FlushPendingNotifications
   * to get an up-to-date view of the document
   * @param aRect is the region to capture into the offscreen buffer, in the
   * root frame's coordinate system (if aIgnoreViewportScrolling is false)
   * or in the root scrolled frame's coordinate system
   * (if aIgnoreViewportScrolling is true). The coordinates are in appunits.
   * @param aFlags see below;
   *   set RENDER_IS_UNTRUSTED if the contents may be passed to malicious
   * agents. E.g. we might choose not to paint the contents of sensitive widgets
   * such as the file name in a file upload widget, and we might choose not
   * to paint themes.
   *   set RENDER_IGNORE_VIEWPORT_SCROLLING to ignore
   * clipping and scrollbar painting due to scrolling in the viewport
   *   set RENDER_CARET to draw the caret if one would be visible
   * (by default the caret is never drawn)
   *   set RENDER_USE_LAYER_MANAGER to force rendering to go through
   * the layer manager for the window. This may be unexpectedly slow
   * (if the layer manager must read back data from the GPU) or low-quality
   * (if the layer manager reads back pixel data and scales it
   * instead of rendering using the appropriate scaling). It may also
   * slow everything down if the area rendered does not correspond to the
   * normal visible area of the window.
   *   set RENDER_ASYNC_DECODE_IMAGES to avoid having images synchronously
   * decoded during rendering.
   * (by default images decode synchronously with RenderDocument)
   *   set RENDER_DOCUMENT_RELATIVE to render the document as if there has been
   * no scrolling and interpret |aRect| relative to the document instead of the
   * CSS viewport. Only considered if RENDER_IGNORE_VIEWPORT_SCROLLING is set
   * or the document is in ignore viewport scrolling mode
   * (nsIPresShell::SetIgnoreViewportScrolling/IgnoringViewportScrolling).
   * @param aBackgroundColor a background color to render onto
   * @param aRenderedContext the gfxContext to render to. We render so that
   * one CSS pixel in the source document is rendered to one unit in the current
   * transform.
   */
  enum {
    RENDER_IS_UNTRUSTED = 0x01,
    RENDER_IGNORE_VIEWPORT_SCROLLING = 0x02,
    RENDER_CARET = 0x04,
    RENDER_USE_WIDGET_LAYERS = 0x08,
    RENDER_ASYNC_DECODE_IMAGES = 0x10,
    RENDER_DOCUMENT_RELATIVE = 0x20,
    RENDER_DRAWWINDOW_NOT_FLUSHING = 0x40
  };
  virtual nsresult RenderDocument(const nsRect& aRect, uint32_t aFlags,
                                  nscolor aBackgroundColor,
                                  gfxContext* aRenderedContext) = 0;

  enum {
    RENDER_IS_IMAGE = 0x100,
    RENDER_AUTO_SCALE = 0x80
  };

  /**
   * Renders a node aNode to a surface and returns it. The aRegion may be used
   * to clip the rendering. This region is measured in CSS pixels from the
   * edge of the presshell area. The aPoint, aScreenRect and aFlags arguments
   * function in a similar manner as RenderSelection.
   */
  virtual already_AddRefed<mozilla::gfx::SourceSurface>
  RenderNode(nsINode* aNode,
             const mozilla::Maybe<mozilla::CSSIntRegion>& aRegion,
             const mozilla::LayoutDeviceIntPoint aPoint,
             mozilla::LayoutDeviceIntRect* aScreenRect,
             uint32_t aFlags) = 0;

  /**
   * Renders a selection to a surface and returns it. This method is primarily
   * intended to create the drag feedback when dragging a selection.
   *
   * aScreenRect will be filled in with the bounding rectangle of the
   * selection area on screen.
   *
   * If the area of the selection is large and the RENDER_AUTO_SCALE flag is
   * set, the image will be scaled down. The argument aPoint is used in this
   * case as a reference point when determining the new screen rectangle after
   * scaling. Typically, this will be the mouse position, so that the screen
   * rectangle is positioned such that the mouse is over the same point in the
   * scaled image as in the original. When scaling does not occur, the mouse
   * point isn't used because the position can be determined from the displayed
   * frames.
   */
  virtual already_AddRefed<mozilla::gfx::SourceSurface>
  RenderSelection(mozilla::dom::Selection* aSelection,
                  const mozilla::LayoutDeviceIntPoint aPoint,
                  mozilla::LayoutDeviceIntRect* aScreenRect,
                  uint32_t aFlags) = 0;

  void AddAutoWeakFrame(AutoWeakFrame* aWeakFrame);
  void AddWeakFrame(WeakFrame* aWeakFrame);

  void RemoveAutoWeakFrame(AutoWeakFrame* aWeakFrame);
  void RemoveWeakFrame(WeakFrame* aWeakFrame);

#ifdef DEBUG
  nsIFrame* GetDrawEventTargetFrame() { return mDrawEventTargetFrame; }
#endif

  /**
   * Stop or restart non synthetic test mouse event handling on *all*
   * presShells.
   *
   * @param aDisable If true, disable all non synthetic test mouse
   * events on all presShells.  Otherwise, enable them.
   */
  virtual void DisableNonTestMouseEvents(bool aDisable) = 0;

  /**
   * Record the background color of the most recently drawn canvas. This color
   * is composited on top of the user's default background color and then used
   * to draw the background color of the canvas. See PresShell::Paint,
   * PresShell::PaintDefaultBackground, and nsDocShell::SetupNewViewer;
   * bug 488242, bug 476557 and other bugs mentioned there.
   */
  void SetCanvasBackground(nscolor aColor) { mCanvasBackgroundColor = aColor; }
  nscolor GetCanvasBackground() { return mCanvasBackgroundColor; }

  /**
   * Use the current frame tree (if it exists) to update the background
   * color of the most recently drawn canvas.
   */
  virtual void UpdateCanvasBackground() = 0;

  /**
   * Add a solid color item to the bottom of aList with frame aFrame and bounds
   * aBounds. Checks first if this needs to be done by checking if aFrame is a
   * canvas frame (if the FORCE_DRAW flag is passed then this check is skipped).
   * aBackstopColor is composed behind the background color of the canvas, it is
   * transparent by default.
   * We attempt to make the background color part of the scrolled canvas (to reduce
   * transparent layers), and if async scrolling is enabled (and the background
   * is opaque) then we add a second, unscrolled item to handle the checkerboarding
   * case.
   * ADD_FOR_SUBDOC shoud be specified when calling this for a subdocument, and
   * LayoutUseContainersForRootFrame might cause the whole list to be scrolled. In
   * that case the second unscrolled item will be elided.
   * APPEND_UNSCROLLED_ONLY only attempts to add the unscrolled item, so that we
   * can add it manually after LayoutUseContainersForRootFrame has built the
   * scrolling ContainerLayer.
   */
  enum {
    FORCE_DRAW = 0x01,
    ADD_FOR_SUBDOC = 0x02,
    APPEND_UNSCROLLED_ONLY = 0x04,
  };
  virtual void AddCanvasBackgroundColorItem(nsDisplayListBuilder& aBuilder,
                                            nsDisplayList& aList,
                                            nsIFrame* aFrame,
                                            const nsRect& aBounds,
                                            nscolor aBackstopColor = NS_RGBA(0,0,0,0),
                                            uint32_t aFlags = 0) = 0;


  /**
   * Add a solid color item to the bottom of aList with frame aFrame and
   * bounds aBounds representing the dark grey background behind the page of a
   * print preview presentation.
   */
  virtual void AddPrintPreviewBackgroundItem(nsDisplayListBuilder& aBuilder,
                                             nsDisplayList& aList,
                                             nsIFrame* aFrame,
                                             const nsRect& aBounds) = 0;

  /**
   * Computes the backstop color for the view: transparent if in a transparent
   * widget, otherwise the PresContext default background color. This color is
   * only visible if the contents of the view as a whole are translucent.
   */
  virtual nscolor ComputeBackstopColor(nsView* aDisplayRoot) = 0;

  void ObserveNativeAnonMutationsForPrint(bool aObserve)
  {
    mObservesMutationsForPrint = aObserve;
  }
  bool ObservesNativeAnonMutationsForPrint()
  {
    return mObservesMutationsForPrint;
  }

  virtual nsresult SetIsActive(bool aIsActive) = 0;

  bool IsActive()
  {
    return mIsActive;
  }

  // mouse capturing
  static CapturingContentInfo gCaptureInfo;

  /**
   * When capturing content is set, it traps all mouse events and retargets
   * them at this content node. If capturing is not allowed
   * (gCaptureInfo.mAllowed is false), then capturing is not set. However, if
   * the CAPTURE_IGNOREALLOWED flag is set, the allowed state is ignored and
   * capturing is set regardless. To disable capture, pass null for the value
   * of aContent.
   *
   * If CAPTURE_RETARGETTOELEMENT is set, all mouse events are targeted at
   * aContent only. Otherwise, mouse events are targeted at aContent or its
   * descendants. That is, descendants of aContent receive mouse events as
   * they normally would, but mouse events outside of aContent are retargeted
   * to aContent.
   *
   * If CAPTURE_PREVENTDRAG is set then drags are prevented from starting while
   * this capture is active.
   *
   * If CAPTURE_POINTERLOCK is set, similar to CAPTURE_RETARGETTOELEMENT, then
   * events are targeted at aContent, but capturing is held more strongly (i.e.,
   * calls to SetCapturingContent won't unlock unless CAPTURE_POINTERLOCK is
   * set again).
   */
  static void SetCapturingContent(nsIContent* aContent, uint8_t aFlags);

  /**
   * Return the active content currently capturing the mouse if any.
   */
  static nsIContent* GetCapturingContent()
  {
    return gCaptureInfo.mContent;
  }

  /**
   * Allow or disallow mouse capturing.
   */
  static void AllowMouseCapture(bool aAllowed)
  {
    gCaptureInfo.mAllowed = aAllowed;
  }

  /**
   * Returns true if there is an active mouse capture that wants to prevent
   * drags.
   */
  static bool IsMouseCapturePreventingDrag()
  {
    return gCaptureInfo.mPreventDrag && gCaptureInfo.mContent;
  }

  /**
   * Keep track of how many times this presshell has been rendered to
   * a window.
   */
  uint64_t GetPaintCount() { return mPaintCount; }
  void IncrementPaintCount() { ++mPaintCount; }

  /**
   * Get the root DOM window of this presShell.
   */
  virtual already_AddRefed<nsPIDOMWindowOuter> GetRootWindow() = 0;

  /**
   * This returns the focused DOM window under our top level window.
   * I.e., when we are deactive, this returns the *last* focused DOM window.
   */
  virtual already_AddRefed<nsPIDOMWindowOuter> GetFocusedDOMWindowInOurWindow() = 0;

  /**
   * Get the focused content under this window.
   */
  already_AddRefed<nsIContent> GetFocusedContentInOurWindow() const;

  /**
   * Get the layer manager for the widget of the root view, if it has
   * one.
   */
  virtual LayerManager* GetLayerManager() = 0;

  /**
   * Return true iff there is a widget rendering this presShell and that
   * widget is APZ-enabled.
   */
  virtual bool AsyncPanZoomEnabled() = 0;

  /**
   * Track whether we're ignoring viewport scrolling for the purposes
   * of painting.  If we are ignoring, then layers aren't clipped to
   * the CSS viewport and scrollbars aren't drawn.
   */
  virtual void SetIgnoreViewportScrolling(bool aIgnore) = 0;
  bool IgnoringViewportScrolling() const
  { return mRenderFlags & STATE_IGNORING_VIEWPORT_SCROLLING; }

   /**
   * Set a "resolution" for the document, which if not 1.0 will
   * allocate more or fewer pixels for rescalable content by a factor
   * of |resolution| in both dimensions.  Return NS_OK iff the
   * resolution bounds are sane, and the resolution of this was
   * actually updated.
   *
   * The resolution defaults to 1.0.
   */
  virtual nsresult SetResolution(float aResolution) = 0;
  float GetResolution() const { return mResolution.valueOr(1.0); }
  virtual float GetCumulativeResolution() = 0;

  /**
   * Calculate the cumulative scale resolution from this document up to
   * but not including the root document.
   */
  virtual float GetCumulativeNonRootScaleResolution() = 0;

  /**
   * Was the current resolution set by the user or just default initialized?
   */
  bool IsResolutionSet() { return mResolution.isSome(); }

  /**
   * Similar to SetResolution() but also increases the scale of the content
   * by the same amount.
   */
  virtual nsresult SetResolutionAndScaleTo(float aResolution) = 0;

  /**
   * Return whether we are scaling to the set resolution.
   * This is initially false; it's set to true by a call to
   * SetResolutionAndScaleTo(), and set to false by a call to SetResolution().
   */
  virtual bool ScaleToResolution() const = 0;

  /**
   * Used by session restore code to restore a resolution before the first
   * paint.
   */
  virtual void SetRestoreResolution(float aResolution,
                                    mozilla::LayoutDeviceIntSize aDisplaySize) = 0;

  /**
   * Returns whether we are in a DrawWindow() call that used the
   * DRAWWINDOW_DO_NOT_FLUSH flag.
   */
  bool InDrawWindowNotFlushing() const
  { return mRenderFlags & STATE_DRAWWINDOW_NOT_FLUSHING; }

  /**
   * Set the isFirstPaint flag.
   */
  void SetIsFirstPaint(bool aIsFirstPaint) { mIsFirstPaint = aIsFirstPaint; }

  /**
   * Get the isFirstPaint flag.
   */
  bool GetIsFirstPaint() const { return mIsFirstPaint; }

  uint32_t GetPresShellId() { return mPresShellId; }

  /**
   * Dispatch a mouse move event based on the most recent mouse position if
   * this PresShell is visible. This is used when the contents of the page
   * moved (aFromScroll is false) or scrolled (aFromScroll is true).
   */
  virtual void SynthesizeMouseMove(bool aFromScroll) = 0;

  enum PaintFlags {
    /* Update the layer tree and paint PaintedLayers. If this is not specified,
     * we may still have to do it if the layer tree lost PaintedLayer contents
     * we need for compositing. */
    PAINT_LAYERS = 0x01,
    /* Composite layers to the window. */
    PAINT_COMPOSITE = 0x02,
    /* Sync-decode images. */
    PAINT_SYNC_DECODE_IMAGES = 0x04
  };
  virtual void Paint(nsView* aViewToPaint, const nsRegion& aDirtyRegion,
                     uint32_t aFlags) = 0;
  virtual nsresult HandleEvent(nsIFrame* aFrame,
                               mozilla::WidgetGUIEvent* aEvent,
                               bool aDontRetargetEvents,
                               nsEventStatus* aEventStatus) = 0;
  virtual bool ShouldIgnoreInvalidation() = 0;
  /**
   * Notify that we're going to call Paint with PAINT_LAYERS
   * on the pres shell for a widget (which might not be this one, since
   * WillPaint is called on all presshells in the same toplevel window as the
   * painted widget). This is issued at a time when it's safe to modify
   * widget geometry.
   */
  virtual void WillPaint() = 0;
  /**
   * Notify that we're going to call Paint with PAINT_COMPOSITE.
   * Fires on the presshell for the painted widget.
   * This is issued at a time when it's safe to modify widget geometry.
   */
  virtual void WillPaintWindow() = 0;
  /**
   * Notify that we called Paint with PAINT_COMPOSITE.
   * Fires on the presshell for the painted widget.
   * This is issued at a time when it's safe to modify widget geometry.
   */
  virtual void DidPaintWindow() = 0;

  /**
   * Ensures that the refresh driver is running, and schedules a view
   * manager flush on the next tick.
   *
   * @param aType PAINT_DELAYED_COMPRESS : Schedule a paint to be executed after a delay, and
   * put FrameLayerBuilder in 'compressed' mode that avoids short cut optimizations.
   */
  enum PaintType {
    PAINT_DEFAULT,
    PAINT_DELAYED_COMPRESS
  };
  virtual void ScheduleViewManagerFlush(PaintType aType = PAINT_DEFAULT) = 0;
  virtual void ClearMouseCaptureOnView(nsView* aView) = 0;
  virtual bool IsVisible() = 0;
  void DispatchSynthMouseMove(mozilla::WidgetGUIEvent* aEvent);

  /* Temporarily ignore the Displayport for better paint performance. We
   * trigger a repaint once suppression is disabled. Without that
   * the displayport may get left at the suppressed size for an extended
   * period of time and result in unnecessary checkerboarding (see bug
   * 1255054). */
  virtual void SuppressDisplayport(bool aEnabled) = 0;

  /* Whether or not displayport suppression should be turned on. Note that
   * this only affects the return value of |IsDisplayportSuppressed()|, and
   * doesn't change the value of the internal counter.
   */
  virtual void RespectDisplayportSuppression(bool aEnabled) = 0;

  /* Whether or not the displayport is currently suppressed. */
  virtual bool IsDisplayportSuppressed() = 0;

  virtual void AddSizeOfIncludingThis(nsWindowSizes& aWindowSizes) const = 0;

  /**
   * Methods that retrieve the cached font inflation preferences.
   */
  uint32_t FontSizeInflationEmPerLine() const {
    return mFontSizeInflationEmPerLine;
  }

  uint32_t FontSizeInflationMinTwips() const {
    return mFontSizeInflationMinTwips;
  }

  uint32_t FontSizeInflationLineThreshold() const {
    return mFontSizeInflationLineThreshold;
  }

  bool FontSizeInflationForceEnabled() const {
    return mFontSizeInflationForceEnabled;
  }

  bool FontSizeInflationDisabledInMasterProcess() const {
    return mFontSizeInflationDisabledInMasterProcess;
  }

  bool FontSizeInflationEnabled() const {
    return mFontSizeInflationEnabled;
  }

  /**
   * Recomputes whether font-size inflation is enabled.
   */
  void RecomputeFontSizeInflationEnabled();

  /**
   * Return true if the most recent interruptible reflow was interrupted.
   */
  bool IsReflowInterrupted() const {
    return mWasLastReflowInterrupted;
  }

  /**
   * Return true if the the interruptible reflows have to be suppressed.
   * This may happen only if if the most recent reflow was interrupted.
   */
  bool SuppressInterruptibleReflows() const {
    return mWasLastReflowInterrupted;
  }

  //////////////////////////////////////////////////////////////////////////////
  // Approximate frame visibility tracking public API.
  //////////////////////////////////////////////////////////////////////////////

  /// Schedule an update of the list of approximately visible frames "soon".
  /// This lets the refresh driver know that we want a visibility update in the
  /// near future. The refresh driver applies its own heuristics and throttling
  /// to decide when to actually perform the visibility update.
  virtual void ScheduleApproximateFrameVisibilityUpdateSoon() = 0;

  /// Schedule an update of the list of approximately visible frames "now". The
  /// update runs asynchronously, but it will be posted to the event loop
  /// immediately. Prefer the "soon" variation of this method when possible, as
  /// this variation ignores the refresh driver's heuristics.
  virtual void ScheduleApproximateFrameVisibilityUpdateNow() = 0;

  /// Clears the current list of approximately visible frames on this pres shell
  /// and replaces it with frames that are in the display list @aList.
  virtual void RebuildApproximateFrameVisibilityDisplayList(const nsDisplayList& aList) = 0;
  virtual void RebuildApproximateFrameVisibility(nsRect* aRect = nullptr,
                                                 bool aRemoveOnly = false) = 0;

  /// Ensures @aFrame is in the list of approximately visible frames.
  virtual void EnsureFrameInApproximatelyVisibleList(nsIFrame* aFrame) = 0;

  /// Removes @aFrame from the list of approximately visible frames if present.
  virtual void RemoveFrameFromApproximatelyVisibleList(nsIFrame* aFrame) = 0;

  /// Whether we should assume all frames are visible.
  virtual bool AssumeAllFramesVisible() = 0;


  /**
   * Returns whether the document's style set's rule processor for the
   * specified level of the cascade is shared by multiple style sets.
   *
   * @param aSheetType One of the nsIStyleSheetService.*_SHEET constants.
   */
  nsresult HasRuleProcessorUsedByMultipleStyleSets(uint32_t aSheetType,
                                                   bool* aRetVal);

  /**
   * Returns whether or not the document has ever handled user input
   */
  virtual bool HasHandledUserInput() const = 0;

  virtual void FireResizeEvent() = 0;

protected:
  /**
   * Refresh observer management.
   */
  void DoObserveStyleFlushes();
  void DoObserveLayoutFlushes();

  /**
   * Does the actual work of figuring out the current state of font size
   * inflation.
   */
  bool DetermineFontSizeInflationState();

  void RecordAlloc(void* aPtr) {
#ifdef MOZ_DIAGNOSTIC_ASSERT_ENABLED
    MOZ_DIAGNOSTIC_ASSERT(!mAllocatedPointers.Contains(aPtr));
    mAllocatedPointers.PutEntry(aPtr);
#endif
  }

  void RecordFree(void* aPtr) {
#ifdef MOZ_DIAGNOSTIC_ASSERT_ENABLED
    MOZ_DIAGNOSTIC_ASSERT(mAllocatedPointers.Contains(aPtr));
    mAllocatedPointers.RemoveEntry(aPtr);
#endif
  }

public:
  bool AddRefreshObserver(nsARefreshObserver* aObserver,
                          mozilla::FlushType aFlushType);
  bool RemoveRefreshObserver(nsARefreshObserver* aObserver,
                             mozilla::FlushType aFlushType);

  virtual bool AddPostRefreshObserver(nsAPostRefreshObserver* aObserver);
  virtual bool RemovePostRefreshObserver(nsAPostRefreshObserver* aObserver);

  // If a frame in the subtree rooted at aFrame is capturing the mouse then
  // clears that capture.
  static void ClearMouseCapture(nsIFrame* aFrame);

  void SetVisualViewportSize(nscoord aWidth, nscoord aHeight);
  bool IsVisualViewportSizeSet() {
    return mVisualViewportSizeSet;
  }
  nsSize GetVisualViewportSize() {
    NS_ASSERTION(mVisualViewportSizeSet, "asking for visual viewport size when its not set?");
    return mVisualViewportSize;
  }

  void SetVisualViewportOffset(const nsPoint& aScrollOffset) {
    mVisualViewportOffset = aScrollOffset;
  }

  nsPoint GetVisualViewportOffset() const {
    return mVisualViewportOffset;
  }

  virtual void WindowSizeMoveDone() = 0;
  virtual void SysColorChanged() = 0;
  virtual void ThemeChanged() = 0;
  virtual void BackingScaleFactorChanged() = 0;

  /**
   * Documents belonging to an invisible DocShell must not be painted ever.
   */
  bool IsNeverPainting() {
    return mIsNeverPainting;
  }

  void SetNeverPainting(bool aNeverPainting) {
    mIsNeverPainting = aNeverPainting;
  }

  /**
   * True if a reflow event has been scheduled, or is going to be scheduled
   * to run in the future.
   */
  bool HasPendingReflow() const
    { return mObservingLayoutFlushes || mReflowContinueTimer; }

  void SyncWindowProperties(nsView* aView);

  virtual nsIDocument* GetPrimaryContentDocument() = 0;

  // aSheetType is one of the nsIStyleSheetService *_SHEET constants.
  virtual void NotifyStyleSheetServiceSheetAdded(mozilla::StyleSheet* aSheet,
                                                 uint32_t aSheetType) = 0;
  virtual void NotifyStyleSheetServiceSheetRemoved(mozilla::StyleSheet* aSheet,
                                                   uint32_t aSheetType) = 0;

protected:
  friend class nsRefreshDriver;

  // IMPORTANT: The ownership implicit in the following member variables
  // has been explicitly checked.  If you add any members to this class,
  // please make the ownership explicit (pinkerton, scc).

  // These are the same Document and PresContext owned by the DocViewer.
  // we must share ownership.
  nsCOMPtr<nsIDocument>     mDocument;
  RefPtr<nsPresContext>   mPresContext;
  mozilla::UniquePtr<mozilla::ServoStyleSet> mStyleSet;
  nsCSSFrameConstructor*    mFrameConstructor; // [OWNS]
  nsViewManager*           mViewManager;   // [WEAK] docViewer owns it so I don't have to
  nsPresArena               mFrameArena;
  RefPtr<nsFrameSelection> mSelection;
  // Pointer into mFrameConstructor - this is purely so that GetRootFrame() can
  // be inlined:
  nsFrameManager*       mFrameManager;
  mozilla::WeakPtr<nsDocShell>                 mForwardingContainer;
#ifdef ACCESSIBILITY
  mozilla::a11y::DocAccessible* mDocAccessible;
#endif

  // At least on Win32 and Mac after interupting a reflow we need to post
  // the resume reflow event off a timer to avoid event starvation because
  // posted messages are processed before other messages when the modal
  // moving/sizing loop is running, see bug 491700 for details.
  nsCOMPtr<nsITimer>        mReflowContinueTimer;

#ifdef DEBUG
  nsIFrame*                 mDrawEventTargetFrame;
#endif

#ifdef MOZ_DIAGNOSTIC_ASSERT_ENABLED
  // We track allocated pointers in a debug-only hashtable to assert against
  // missing/double frees.
  nsTHashtable<nsPtrHashKey<void>> mAllocatedPointers;
#endif

  // Count of the number of times this presshell has been painted to a window.
  uint64_t                  mPaintCount;

  nsSize                    mVisualViewportSize;

  nsPoint                   mVisualViewportOffset;

  // A list of stack weak frames. This is a pointer to the last item in the list.
  AutoWeakFrame*            mAutoWeakFrames;

  // A hash table of heap allocated weak frames.
  nsTHashtable<nsPtrHashKey<WeakFrame>> mWeakFrames;

  // Reflow roots that need to be reflowed.
  nsTArray<nsIFrame*> mDirtyRoots;

#ifdef MOZ_GECKO_PROFILER
  // These two fields capture call stacks of any changes that require a restyle
  // or a reflow. Only the first change per restyle / reflow is recorded (the
  // one that caused a call to SetNeedStyleFlush() / SetNeedLayoutFlush()).
  UniqueProfilerBacktrace mStyleCause;
  UniqueProfilerBacktrace mReflowCause;
#endif

  // Most recent canvas background color.
  nscolor                   mCanvasBackgroundColor;

  // Used to force allocation and rendering of proportionally more or
  // less pixels in both dimensions.
  mozilla::Maybe<float>     mResolution;

  int16_t                   mSelectionFlags;

  // This is used to protect ourselves from triggering reflow while in the
  // middle of frame construction and the like... it really shouldn't be
  // needed, one hopes, but it is for now.
  uint16_t                  mChangeNestCount;

  // Flags controlling how our document is rendered.  These persist
  // between paints and so are tied with retained layer pixels.
  // PresShell flushes retained layers when the rendering state
  // changes in a way that prevents us from being able to (usefully)
  // re-use old pixels.
  RenderFlags               mRenderFlags;
  bool                      mDidInitialize : 1;
  bool                      mIsDestroying : 1;
  bool                      mIsReflowing : 1;
  bool                      mIsObservingDocument : 1;

  // We've been disconnected from the document.  We will refuse to paint the
  // document until either our timer fires or all frames are constructed.
  bool                      mIsDocumentGone : 1;

  // For all documents we initially lock down painting.
  bool                      mPaintingSuppressed : 1;

  bool                      mIsActive : 1;
  bool                      mFrozen : 1;
  bool                      mIsFirstPaint : 1;
  bool                      mObservesMutationsForPrint : 1;

  // Whether the most recent interruptible reflow was actually interrupted:
  bool                      mWasLastReflowInterrupted : 1;
  bool                      mVisualViewportSizeSet : 1;

  // True if a layout flush might not be a no-op
  bool mNeedLayoutFlush : 1;

  // True if a style flush might not be a no-op
  bool mNeedStyleFlush : 1;

  // True if we're observing the refresh driver for style flushes.
  bool mObservingStyleFlushes: 1;

  // True if we're observing the refresh driver for layout flushes, that is, if
  // we have a reflow scheduled.
  //
  // Guaranteed to be false if mReflowContinueTimer is non-null.
  bool mObservingLayoutFlushes: 1;

  bool mResizeEventPending : 1;

  // True if there are throttled animations that would be processed when
  // performing a flush with mFlushAnimations == true.
  bool mNeedThrottledAnimationFlush : 1;

  uint32_t                  mPresShellId;

  static nsIContent*        gKeyDownTarget;

  // Cached font inflation values. This is done to prevent changing of font
  // inflation until a page is reloaded.
  uint32_t mFontSizeInflationEmPerLine;
  uint32_t mFontSizeInflationMinTwips;
  uint32_t mFontSizeInflationLineThreshold;
  bool mFontSizeInflationForceEnabled;
  bool mFontSizeInflationDisabledInMasterProcess;
  bool mFontSizeInflationEnabled;

  bool mPaintingIsFrozen;

  // If a document belongs to an invisible DocShell, this flag must be set
  // to true, so we can avoid any paint calls for widget related to this
  // presshell.
  bool mIsNeverPainting;

  // Whether we're currently under a FlushPendingNotifications.
  // This is used to handle flush reentry correctly.
  bool mInFlush;
};

NS_DEFINE_STATIC_IID_ACCESSOR(nsIPresShell, NS_IPRESSHELL_IID)

#endif /* nsIPresShell_h___ */
