/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsNativeTheme.h"
#include "nsIWidget.h"
#include "nsIDocument.h"
#include "nsIContent.h"
#include "nsIFrame.h"
#include "nsIPresShell.h"
#include "nsNumberControlFrame.h"
#include "nsPresContext.h"
#include "nsString.h"
#include "nsNameSpaceManager.h"
#include "nsIDOMXULMenuListElement.h"
#include "nsStyleConsts.h"
#include "nsIComponentManager.h"
#include "nsPIDOMWindow.h"
#include "nsProgressFrame.h"
#include "nsMeterFrame.h"
#include "nsMenuFrame.h"
#include "nsRangeFrame.h"
#include "nsCSSRendering.h"
#include "mozilla/EventStates.h"
#include "mozilla/dom/Element.h"
#include "mozilla/dom/HTMLBodyElement.h"
#include "mozilla/dom/HTMLInputElement.h"
#include "mozilla/dom/HTMLProgressElement.h"
#include "mozilla/StaticPrefs.h"
#include "nsIDocumentInlines.h"
#include <algorithm>

using namespace mozilla;
using namespace mozilla::dom;

nsNativeTheme::nsNativeTheme()
: mAnimatedContentTimeout(UINT32_MAX)
{
}

NS_IMPL_ISUPPORTS(nsNativeTheme, nsITimerCallback, nsINamed)

nsIPresShell *
nsNativeTheme::GetPresShell(nsIFrame* aFrame)
{
  if (!aFrame)
    return nullptr;

  nsPresContext* context = aFrame->PresContext();
  return context ? context->GetPresShell() : nullptr;
}

EventStates
nsNativeTheme::GetContentState(nsIFrame* aFrame, StyleAppearance aWidgetType)
{
  if (!aFrame)
    return EventStates();

  bool isXULCheckboxRadio =
    (aWidgetType == StyleAppearance::Checkbox ||
     aWidgetType == StyleAppearance::Radio) &&
    aFrame->GetContent()->IsXULElement();
  if (isXULCheckboxRadio)
    aFrame = aFrame->GetParent();

  if (!aFrame->GetContent())
    return EventStates();

  nsIPresShell *shell = GetPresShell(aFrame);
  if (!shell)
    return EventStates();

  nsIContent* frameContent = aFrame->GetContent();
  EventStates flags;
  if (frameContent->IsElement()) {
    flags = frameContent->AsElement()->State();

    // <input type=number> needs special handling since its nested native
    // anonymous <input type=text> takes focus for it.
    if (aWidgetType == StyleAppearance::NumberInput &&
        frameContent->IsHTMLElement(nsGkAtoms::input)) {
      nsNumberControlFrame *numberControlFrame = do_QueryFrame(aFrame);
      if (numberControlFrame && numberControlFrame->IsFocused()) {
        flags |= NS_EVENT_STATE_FOCUS;
      }
    }

    nsNumberControlFrame* numberControlFrame =
      nsNumberControlFrame::GetNumberControlFrameForSpinButton(aFrame);
    if (numberControlFrame &&
        numberControlFrame->GetContent()->AsElement()->State().
          HasState(NS_EVENT_STATE_DISABLED)) {
      flags |= NS_EVENT_STATE_DISABLED;
    }
  }
  
  if (isXULCheckboxRadio && aWidgetType == StyleAppearance::Radio) {
    if (IsFocused(aFrame))
      flags |= NS_EVENT_STATE_FOCUS;
  }

  // On Windows and Mac, only draw focus rings if they should be shown. This
  // means that focus rings are only shown once the keyboard has been used to
  // focus something in the window.
#if defined(XP_MACOSX)
  // Mac always draws focus rings for textboxes and lists.
  if (aWidgetType == StyleAppearance::NumberInput ||
      aWidgetType == StyleAppearance::Textfield ||
      aWidgetType == StyleAppearance::TextfieldMultiline ||
      aWidgetType == StyleAppearance::Searchfield ||
      aWidgetType == StyleAppearance::Listbox) {
    return flags;
  }
#endif
#if defined(XP_WIN)
  // On Windows, focused buttons are always drawn as such by the native theme.
  if (aWidgetType == StyleAppearance::Button)
    return flags;
#endif    
#if defined(XP_MACOSX) || defined(XP_WIN)
  nsIDocument* doc = aFrame->GetContent()->OwnerDoc();
  nsPIDOMWindowOuter* window = doc->GetWindow();
  if (window && !window->ShouldShowFocusRing())
    flags &= ~NS_EVENT_STATE_FOCUS;
#endif
  
  return flags;
}

/* static */
bool
nsNativeTheme::CheckBooleanAttr(nsIFrame* aFrame, nsAtom* aAtom)
{
  if (!aFrame)
    return false;

  nsIContent* content = aFrame->GetContent();
  if (!content || !content->IsElement())
    return false;

  if (content->IsHTMLElement())
    return content->AsElement()->HasAttr(kNameSpaceID_None, aAtom);

  // For XML/XUL elements, an attribute must be equal to the literal
  // string "true" to be counted as true.  An empty string should _not_
  // be counted as true.
  return content->AsElement()->AttrValueIs(kNameSpaceID_None, aAtom,
                                           NS_LITERAL_STRING("true"),
                                           eCaseMatters);
}

/* static */
int32_t
nsNativeTheme::CheckIntAttr(nsIFrame* aFrame, nsAtom* aAtom, int32_t defaultValue)
{
  if (!aFrame)
    return defaultValue;

  nsIContent* content = aFrame->GetContent();
  if (!content || !content->IsElement())
    return defaultValue;

  nsAutoString attr;
  content->AsElement()->GetAttr(kNameSpaceID_None, aAtom, attr);
  nsresult err;
  int32_t value = attr.ToInteger(&err);
  if (attr.IsEmpty() || NS_FAILED(err))
    return defaultValue;

  return value;
}

/* static */
double
nsNativeTheme::GetProgressValue(nsIFrame* aFrame)
{
  // When we are using the HTML progress element,
  // we can get the value from the IDL property.
  if (aFrame && aFrame->GetContent()->IsHTMLElement(nsGkAtoms::progress)) {
    return static_cast<HTMLProgressElement*>(aFrame->GetContent())->Value();
  }

  return (double)nsNativeTheme::CheckIntAttr(aFrame, nsGkAtoms::value, 0);
}

/* static */
double
nsNativeTheme::GetProgressMaxValue(nsIFrame* aFrame)
{
  // When we are using the HTML progress element,
  // we can get the max from the IDL property.
  if (aFrame && aFrame->GetContent()->IsHTMLElement(nsGkAtoms::progress)) {
    return static_cast<HTMLProgressElement*>(aFrame->GetContent())->Max();
  }

  return (double)std::max(nsNativeTheme::CheckIntAttr(aFrame, nsGkAtoms::max, 100), 1);
}

bool
nsNativeTheme::GetCheckedOrSelected(nsIFrame* aFrame, bool aCheckSelected)
{
  if (!aFrame)
    return false;

  nsIContent* content = aFrame->GetContent();

  if (content->IsXULElement()) {
    // For a XUL checkbox or radio button, the state of the parent determines
    // the checked state
    aFrame = aFrame->GetParent();
  } else {
    // Check for an HTML input element
    HTMLInputElement* inputElt = HTMLInputElement::FromNode(content);
    if (inputElt) {
      return inputElt->Checked();
    }
  }

  return CheckBooleanAttr(aFrame, aCheckSelected ? nsGkAtoms::selected
                                                 : nsGkAtoms::checked);
}

bool
nsNativeTheme::IsButtonTypeMenu(nsIFrame* aFrame)
{
  if (!aFrame)
    return false;

  nsIContent* content = aFrame->GetContent();
  return content->IsXULElement(nsGkAtoms::button) &&
         content->AsElement()->AttrValueIs(kNameSpaceID_None, nsGkAtoms::type,
                                           NS_LITERAL_STRING("menu"),
                                           eCaseMatters);
}

bool
nsNativeTheme::IsPressedButton(nsIFrame* aFrame)
{
  EventStates eventState = GetContentState(aFrame, StyleAppearance::Toolbarbutton);
  if (IsDisabled(aFrame, eventState))
    return false;

  return IsOpenButton(aFrame) ||
         eventState.HasAllStates(NS_EVENT_STATE_ACTIVE | NS_EVENT_STATE_HOVER);
}


bool
nsNativeTheme::GetIndeterminate(nsIFrame* aFrame)
{
  if (!aFrame)
    return false;

  nsIContent* content = aFrame->GetContent();

  if (content->IsXULElement()) {
    // For a XUL checkbox or radio button, the state of the parent determines
    // the state
    return CheckBooleanAttr(aFrame->GetParent(), nsGkAtoms::indeterminate);
  }

  // Check for an HTML input element
  HTMLInputElement* inputElt = HTMLInputElement::FromNode(content);
  if (inputElt) {
    return inputElt->Indeterminate();
  }

  return false;
}

bool
nsNativeTheme::IsWidgetStyled(nsPresContext* aPresContext, nsIFrame* aFrame,
                              StyleAppearance aWidgetType)
{
  // Check for specific widgets to see if HTML has overridden the style.
  if (!aFrame)
    return false;

  // Resizers have some special handling, dependent on whether in a scrollable
  // container or not. If so, use the scrollable container's to determine
  // whether the style is overriden instead of the resizer. This allows a
  // non-native transparent resizer to be used instead. Otherwise, we just
  // fall through and return false.
  if (aWidgetType == StyleAppearance::Resizer) {
    nsIFrame* parentFrame = aFrame->GetParent();
    if (parentFrame && parentFrame->IsScrollFrame()) {
      // if the parent is a scrollframe, the resizer should be native themed
      // only if the scrollable area doesn't override the widget style.
      parentFrame = parentFrame->GetParent();
      if (parentFrame) {
        return IsWidgetStyled(aPresContext, parentFrame,
                              parentFrame->StyleDisplay()->mAppearance);
      }
    }
  }

  /**
   * Progress bar appearance should be the same for the bar and the container
   * frame. nsProgressFrame owns the logic and will tell us what we should do.
   */
  if (aWidgetType == StyleAppearance::Progresschunk ||
      aWidgetType == StyleAppearance::Progressbar) {
    nsProgressFrame* progressFrame = do_QueryFrame(aWidgetType == StyleAppearance::Progresschunk
                                       ? aFrame->GetParent() : aFrame);
    if (progressFrame) {
      return !progressFrame->ShouldUseNativeStyle();
    }
  }

  /**
   * Meter bar appearance should be the same for the bar and the container
   * frame. nsMeterFrame owns the logic and will tell us what we should do.
   */
  if (aWidgetType == StyleAppearance::Meterchunk ||
      aWidgetType == StyleAppearance::Meterbar) {
    nsMeterFrame* meterFrame = do_QueryFrame(aWidgetType == StyleAppearance::Meterchunk
                                       ? aFrame->GetParent() : aFrame);
    if (meterFrame) {
      return !meterFrame->ShouldUseNativeStyle();
    }
  }

  /**
   * An nsRangeFrame and its children are treated atomically when it
   * comes to native theming (either all parts, or no parts, are themed).
   * nsRangeFrame owns the logic and will tell us what we should do.
   */
  if (aWidgetType == StyleAppearance::Range ||
      aWidgetType == StyleAppearance::RangeThumb) {
    nsRangeFrame* rangeFrame =
      do_QueryFrame(aWidgetType == StyleAppearance::RangeThumb
                      ? aFrame->GetParent() : aFrame);
    if (rangeFrame) {
      return !rangeFrame->ShouldUseNativeStyle();
    }
  }

  if (aWidgetType == StyleAppearance::SpinnerUpbutton ||
      aWidgetType == StyleAppearance::SpinnerDownbutton) {
    nsNumberControlFrame* numberControlFrame =
      nsNumberControlFrame::GetNumberControlFrameForSpinButton(aFrame);
    if (numberControlFrame) {
      return !numberControlFrame->ShouldUseNativeStyleForSpinner();
    }
  }

  return (aWidgetType == StyleAppearance::NumberInput ||
          aWidgetType == StyleAppearance::Button ||
          aWidgetType == StyleAppearance::Textfield ||
          aWidgetType == StyleAppearance::TextfieldMultiline ||
          aWidgetType == StyleAppearance::Listbox ||
          aWidgetType == StyleAppearance::Menulist ||
          (aWidgetType == StyleAppearance::MenulistButton &&
           StaticPrefs::layout_css_webkit_appearance_enabled())) &&
         aFrame->GetContent()->IsHTMLElement() &&
         aPresContext->HasAuthorSpecifiedRules(aFrame,
                                               NS_AUTHOR_SPECIFIED_BORDER |
                                               NS_AUTHOR_SPECIFIED_BACKGROUND);
}

bool
nsNativeTheme::IsDisabled(nsIFrame* aFrame, EventStates aEventStates)
{
  if (!aFrame) {
    return false;
  }

  nsIContent* content = aFrame->GetContent();
  if (!content || !content->IsElement()) {
    return false;
  }

  if (content->IsHTMLElement()) {
    return aEventStates.HasState(NS_EVENT_STATE_DISABLED);
  }

  // For XML/XUL elements, an attribute must be equal to the literal
  // string "true" to be counted as true.  An empty string should _not_
  // be counted as true.
  return content->AsElement()->AttrValueIs(kNameSpaceID_None,
                                           nsGkAtoms::disabled,
                                           NS_LITERAL_STRING("true"),
                                           eCaseMatters);
}

/* static */ bool
nsNativeTheme::IsFrameRTL(nsIFrame* aFrame)
{
  if (!aFrame) {
    return false;
  }
  WritingMode wm = aFrame->GetWritingMode();
  return !(wm.IsVertical() ? wm.IsVerticalLR() : wm.IsBidiLTR());
}

bool
nsNativeTheme::IsHTMLContent(nsIFrame *aFrame)
{
  if (!aFrame) {
    return false;
  }
  nsIContent* content = aFrame->GetContent();
  return content && content->IsHTMLElement();
}


// scrollbar button:
int32_t
nsNativeTheme::GetScrollbarButtonType(nsIFrame* aFrame)
{
  if (!aFrame)
    return 0;

  static Element::AttrValuesArray strings[] =
    {&nsGkAtoms::scrollbarDownBottom, &nsGkAtoms::scrollbarDownTop,
     &nsGkAtoms::scrollbarUpBottom, &nsGkAtoms::scrollbarUpTop,
     nullptr};

  nsIContent* content = aFrame->GetContent();
  if (!content || !content->IsElement()) {
    return 0;
  }

  switch (content->AsElement()->FindAttrValueIn(kNameSpaceID_None,
                                                nsGkAtoms::sbattr,
                                                strings, eCaseMatters)) {
    case 0: return eScrollbarButton_Down | eScrollbarButton_Bottom;
    case 1: return eScrollbarButton_Down;
    case 2: return eScrollbarButton_Bottom;
    case 3: return eScrollbarButton_UpTop;
  }

  return 0;
}

// treeheadercell:
nsNativeTheme::TreeSortDirection
nsNativeTheme::GetTreeSortDirection(nsIFrame* aFrame)
{
  if (!aFrame || !aFrame->GetContent())
    return eTreeSortDirection_Natural;

  static Element::AttrValuesArray strings[] =
    {&nsGkAtoms::descending, &nsGkAtoms::ascending, nullptr};

  nsIContent* content = aFrame->GetContent();
  if (content->IsElement()) {
      switch (content->AsElement()->FindAttrValueIn(kNameSpaceID_None,
                                                    nsGkAtoms::sortDirection,
                                                    strings, eCaseMatters)) {
        case 0: return eTreeSortDirection_Descending;
        case 1: return eTreeSortDirection_Ascending;
      }
  }

  return eTreeSortDirection_Natural;
}

bool
nsNativeTheme::IsLastTreeHeaderCell(nsIFrame* aFrame)
{
  if (!aFrame)
    return false;

  // A tree column picker is always the last header cell.
  if (aFrame->GetContent()->IsXULElement(nsGkAtoms::treecolpicker))
    return true;

  // Find the parent tree.
  nsIContent* parent = aFrame->GetContent()->GetParent();
  while (parent && !parent->IsXULElement(nsGkAtoms::tree)) {
    parent = parent->GetParent();
  }

  // If the column picker is visible, this can't be the last column.
  if (parent && !parent->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                  nsGkAtoms::hidecolumnpicker,
                                                  NS_LITERAL_STRING("true"),
                                                  eCaseMatters))
    return false;

  while ((aFrame = aFrame->GetNextSibling())) {
    if (aFrame->GetRect().Width() > 0)
      return false;
  }
  return true;
}

// tab:
bool
nsNativeTheme::IsBottomTab(nsIFrame* aFrame)
{
  if (!aFrame)
    return false;

  nsAutoString classStr;
  if (aFrame->GetContent()->IsElement()) {
    aFrame->GetContent()->AsElement()->GetAttr(kNameSpaceID_None,
                                               nsGkAtoms::_class,
                                               classStr);
  }
  // FIXME: This looks bogus, shouldn't this be looking at GetClasses()?
  return !classStr.IsEmpty() && classStr.Find("tab-bottom") != kNotFound;
}

bool
nsNativeTheme::IsFirstTab(nsIFrame* aFrame)
{
  if (!aFrame)
    return false;

  for (nsIFrame* first : aFrame->GetParent()->PrincipalChildList()) {
    if (first->GetRect().Width() > 0 &&
        first->GetContent()->IsXULElement(nsGkAtoms::tab))
      return (first == aFrame);
  }
  return false;
}

bool
nsNativeTheme::IsHorizontal(nsIFrame* aFrame)
{
  if (!aFrame)
    return false;

  if (!aFrame->GetContent()->IsElement())
    return true;

  return !aFrame->GetContent()->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                         nsGkAtoms::orient,
                                                         nsGkAtoms::vertical,
                                                         eCaseMatters);
}

bool
nsNativeTheme::IsNextToSelectedTab(nsIFrame* aFrame, int32_t aOffset)
{
  if (!aFrame)
    return false;

  if (aOffset == 0)
    return IsSelectedTab(aFrame);

  int32_t thisTabIndex = -1, selectedTabIndex = -1;

  nsIFrame* currentTab = aFrame->GetParent()->PrincipalChildList().FirstChild();
  for (int32_t i = 0; currentTab; currentTab = currentTab->GetNextSibling()) {
    if (currentTab->GetRect().Width() == 0)
      continue;
    if (aFrame == currentTab)
      thisTabIndex = i;
    if (IsSelectedTab(currentTab))
      selectedTabIndex = i;
    ++i;
  }

  if (thisTabIndex == -1 || selectedTabIndex == -1)
    return false;

  return (thisTabIndex - selectedTabIndex == aOffset);
}

// progressbar:
bool
nsNativeTheme::IsIndeterminateProgress(nsIFrame* aFrame,
                                       EventStates aEventStates)
{
  if (!aFrame || !aFrame->GetContent()|| !aFrame->GetContent()->IsElement())
    return false;

  if (aFrame->GetContent()->IsHTMLElement(nsGkAtoms::progress)) {
    return aEventStates.HasState(NS_EVENT_STATE_INDETERMINATE);
  }

  return aFrame->GetContent()->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                        nsGkAtoms::mode,
                                                        NS_LITERAL_STRING("undetermined"),
                                                        eCaseMatters);
}

bool
nsNativeTheme::IsVerticalProgress(nsIFrame* aFrame)
{
  if (!aFrame) {
    return false;
  }
  return IsVerticalMeter(aFrame);
}

bool
nsNativeTheme::IsVerticalMeter(nsIFrame* aFrame)
{
  MOZ_ASSERT(aFrame, "You have to pass a non-null aFrame");
  switch (aFrame->StyleDisplay()->mOrient) {
    case StyleOrient::Horizontal:
      return false;
    case StyleOrient::Vertical:
      return true;
    case StyleOrient::Inline:
      return aFrame->GetWritingMode().IsVertical();
    case StyleOrient::Block:
      return !aFrame->GetWritingMode().IsVertical();
  }
  MOZ_ASSERT_UNREACHABLE("unexpected -moz-orient value");
  return false;
}

// menupopup:
bool
nsNativeTheme::IsSubmenu(nsIFrame* aFrame, bool* aLeftOfParent)
{
  if (!aFrame)
    return false;

  nsIContent* parentContent = aFrame->GetContent()->GetParent();
  if (!parentContent || !parentContent->IsXULElement(nsGkAtoms::menu))
    return false;

  nsIFrame* parent = aFrame;
  while ((parent = parent->GetParent())) {
    if (parent->GetContent() == parentContent) {
      if (aLeftOfParent) {
        LayoutDeviceIntRect selfBounds, parentBounds;
        selfBounds = aFrame->GetNearestWidget()->GetScreenBounds();
        parentBounds = parent->GetNearestWidget()->GetScreenBounds();
        *aLeftOfParent = selfBounds.X() < parentBounds.X();
      }
      return true;
    }
  }

  return false;
}

bool
nsNativeTheme::IsRegularMenuItem(nsIFrame *aFrame)
{
  nsMenuFrame *menuFrame = do_QueryFrame(aFrame);
  return !(menuFrame && (menuFrame->IsOnMenuBar() ||
                         menuFrame->GetParentMenuListType() != eNotMenuList));
}

bool
nsNativeTheme::IsMenuListEditable(nsIFrame *aFrame)
{
  bool isEditable = false;
  nsCOMPtr<nsIDOMXULMenuListElement> menulist = do_QueryInterface(aFrame->GetContent());
  if (menulist)
    menulist->GetEditable(&isEditable);
  return isEditable;
}

bool
nsNativeTheme::QueueAnimatedContentForRefresh(nsIContent* aContent,
                                              uint32_t aMinimumFrameRate)
{
  NS_ASSERTION(aContent, "Null pointer!");
  NS_ASSERTION(aMinimumFrameRate, "aMinimumFrameRate must be non-zero!");
  NS_ASSERTION(aMinimumFrameRate <= 1000,
               "aMinimumFrameRate must be less than 1000!");

  uint32_t timeout = 1000 / aMinimumFrameRate;
  timeout = std::min(mAnimatedContentTimeout, timeout);

  if (!mAnimatedContentTimer) {
    mAnimatedContentTimer = NS_NewTimer();
    NS_ENSURE_TRUE(mAnimatedContentTimer, false);
  }

  if (mAnimatedContentList.IsEmpty() || timeout != mAnimatedContentTimeout) {
    nsresult rv;
    if (!mAnimatedContentList.IsEmpty()) {
      rv = mAnimatedContentTimer->Cancel();
      NS_ENSURE_SUCCESS(rv, false);
    }

    if (XRE_IsContentProcess() && NS_IsMainThread()) {
      mAnimatedContentTimer->SetTarget(aContent->OwnerDoc()->EventTargetFor(TaskCategory::Other));
    }
    rv = mAnimatedContentTimer->InitWithCallback(this, timeout,
                                                 nsITimer::TYPE_ONE_SHOT);
    NS_ENSURE_SUCCESS(rv, false);

    mAnimatedContentTimeout = timeout;
  }

  if (!mAnimatedContentList.AppendElement(aContent)) {
    NS_WARNING("Out of memory!");
    return false;
  }

  return true;
}

NS_IMETHODIMP
nsNativeTheme::Notify(nsITimer* aTimer)
{
  NS_ASSERTION(aTimer == mAnimatedContentTimer, "Wrong timer!");

  // XXX Assumes that calling nsIFrame::Invalidate won't reenter
  //     QueueAnimatedContentForRefresh.

  uint32_t count = mAnimatedContentList.Length();
  for (uint32_t index = 0; index < count; index++) {
    nsIFrame* frame = mAnimatedContentList[index]->GetPrimaryFrame();
    if (frame) {
      frame->InvalidateFrame();
    }
  }

  mAnimatedContentList.Clear();
  mAnimatedContentTimeout = UINT32_MAX;
  return NS_OK;
}

NS_IMETHODIMP
nsNativeTheme::GetName(nsACString& aName)
{
  aName.AssignLiteral("nsNativeTheme");
  return NS_OK;
}

nsIFrame*
nsNativeTheme::GetAdjacentSiblingFrameWithSameAppearance(nsIFrame* aFrame,
                                                         bool aNextSibling)
{
  if (!aFrame)
    return nullptr;

  // Find the next visible sibling.
  nsIFrame* sibling = aFrame;
  do {
    sibling = aNextSibling ? sibling->GetNextSibling() : sibling->GetPrevSibling();
  } while (sibling && sibling->GetRect().Width() == 0);

  // Check same appearance and adjacency.
  if (!sibling ||
      sibling->StyleDisplay()->mAppearance != aFrame->StyleDisplay()->mAppearance ||
      (sibling->GetRect().XMost() != aFrame->GetRect().X() &&
       aFrame->GetRect().XMost() != sibling->GetRect().X()))
    return nullptr;
  return sibling;
}

bool
nsNativeTheme::IsRangeHorizontal(nsIFrame* aFrame)
{
  nsIFrame* rangeFrame = aFrame;
  if (!rangeFrame->IsRangeFrame()) {
    // If the thumb's frame is passed in, get its range parent:
    rangeFrame = aFrame->GetParent();
  }
  if (rangeFrame->IsRangeFrame()) {
    return static_cast<nsRangeFrame*>(rangeFrame)->IsHorizontal();
  }
  // Not actually a range frame - just use the ratio of the frame's size to
  // decide:
  return aFrame->GetSize().width >= aFrame->GetSize().height;
}

static nsIFrame*
GetBodyFrame(nsIFrame* aCanvasFrame)
{
  nsIContent* content = aCanvasFrame->GetContent();
  if (!content) {
    return nullptr;
  }
  nsIDocument* document = content->OwnerDoc();
  nsIContent* body = document->GetBodyElement();
  if (!body) {
    return nullptr;
  }
  return body->GetPrimaryFrame();
}

bool
nsNativeTheme::IsDarkBackground(nsIFrame* aFrame)
{
  nsIScrollableFrame* scrollFrame = nullptr;
  while (!scrollFrame && aFrame) {
    scrollFrame = aFrame->GetScrollTargetFrame();
    aFrame = aFrame->GetParent();
  }
  if (!scrollFrame)
    return false;

  nsIFrame* frame = scrollFrame->GetScrolledFrame();
  if (nsCSSRendering::IsCanvasFrame(frame)) {
    // For canvas frames, prefer to look at the body first, because the body
    // background color is most likely what will be visible as the background
    // color of the page, even if the html element has a different background
    // color which prevents that of the body frame to propagate to the viewport.
    nsIFrame* bodyFrame = GetBodyFrame(frame);
    if (bodyFrame) {
      frame = bodyFrame;
    }
  }
  ComputedStyle* bgSC = nullptr;
  if (!nsCSSRendering::FindBackground(frame, &bgSC) ||
      bgSC->StyleBackground()->IsTransparent(bgSC)) {
    nsIFrame* backgroundFrame = nsCSSRendering::FindNonTransparentBackgroundFrame(frame, true);
    nsCSSRendering::FindBackground(backgroundFrame, &bgSC);
  }
  if (bgSC) {
    nscolor bgColor = bgSC->StyleBackground()->BackgroundColor(bgSC);
    // Consider the background color dark if the sum of the r, g and b values is
    // less than 384 in a semi-transparent document.  This heuristic matches what
    // WebKit does, and we can improve it later if needed.
    return NS_GET_A(bgColor) > 127 &&
           NS_GET_R(bgColor) + NS_GET_G(bgColor) + NS_GET_B(bgColor) < 384;
  }
  return false;
}

bool
nsNativeTheme::IsWidgetScrollbarPart(StyleAppearance aWidgetType)
{
  switch (aWidgetType) {
    case StyleAppearance::Scrollbar:
    case StyleAppearance::ScrollbarSmall:
    case StyleAppearance::ScrollbarVertical:
    case StyleAppearance::ScrollbarHorizontal:
    case StyleAppearance::ScrollbarbuttonUp:
    case StyleAppearance::ScrollbarbuttonDown:
    case StyleAppearance::ScrollbarbuttonLeft:
    case StyleAppearance::ScrollbarbuttonRight:
    case StyleAppearance::ScrollbarthumbVertical:
    case StyleAppearance::ScrollbarthumbHorizontal:
    case StyleAppearance::Scrollcorner:
      return true;
    default:
      return false;
  }
}

static nscolor
GetOpaqueBackgroundColor(ComputedStyle* aStyle)
{
  nscolor color = aStyle->StyleBackground()->BackgroundColor(aStyle);
  if (NS_GET_A(color) == 255) {
    return color;
  }
  // Compose white background with the background color.
  return NS_ComposeColors(NS_RGB(255, 255, 255), color);
}

nscolor
nsNativeTheme::GetScrollbarFaceColor(ComputedStyle* aStyle,
                                     AutoColorGetter aAutoGetter)
{
  StyleComplexColor complexColor = aStyle->StyleUI()->mScrollbarFaceColor;
  if (complexColor.IsAuto()) {
    return aAutoGetter(aStyle);
  }
  nscolor color = complexColor.CalcColor(aStyle);
  if (NS_GET_A(color) == 255) {
    return color;
  }
  nscolor bgColor = GetOpaqueBackgroundColor(aStyle);
  return NS_ComposeColors(bgColor, color);
}

nscolor
nsNativeTheme::GetScrollbarTrackColor(ComputedStyle* aStyle,
                                      AutoColorGetter aAutoGetter)
{
  StyleComplexColor complexColor = aStyle->StyleUI()->mScrollbarTrackColor;
  nscolor color;
  if (complexColor.IsAuto()) {
    color = aAutoGetter(aStyle);
  } else {
    color = complexColor.CalcColor(aStyle);
  }
  if (NS_GET_A(color) == 255) {
    return color;
  }
  nscolor bgColor = GetOpaqueBackgroundColor(aStyle);
  return NS_ComposeColors(bgColor, color);
}
