/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsNumberControlFrame.h"

#include "HTMLInputElement.h"
#include "ICUUtils.h"
#include "nsIFocusManager.h"
#include "nsIPresShell.h"
#include "nsFocusManager.h"
#include "nsFontMetrics.h"
#include "nsCheckboxRadioFrame.h"
#include "nsGkAtoms.h"
#include "nsNameSpaceManager.h"
#include "nsStyleConsts.h"
#include "mozilla/BasicEvents.h"
#include "mozilla/EventStates.h"
#include "nsContentUtils.h"
#include "nsContentCreatorFunctions.h"
#include "nsCSSPseudoElements.h"
#include "nsThreadUtils.h"
#include "mozilla/FloatingPoint.h"
#include "mozilla/dom/MutationEventBinding.h"

#ifdef ACCESSIBILITY
#include "mozilla/a11y/AccTypes.h"
#endif

using namespace mozilla;
using namespace mozilla::dom;

nsIFrame*
NS_NewNumberControlFrame(nsIPresShell* aPresShell, ComputedStyle* aStyle)
{
  return new (aPresShell) nsNumberControlFrame(aStyle);
}

NS_IMPL_FRAMEARENA_HELPERS(nsNumberControlFrame)

NS_QUERYFRAME_HEAD(nsNumberControlFrame)
  NS_QUERYFRAME_ENTRY(nsNumberControlFrame)
  NS_QUERYFRAME_ENTRY(nsIAnonymousContentCreator)
  NS_QUERYFRAME_ENTRY(nsIFormControlFrame)
NS_QUERYFRAME_TAIL_INHERITING(nsContainerFrame)

nsNumberControlFrame::nsNumberControlFrame(ComputedStyle* aStyle)
  : nsContainerFrame(aStyle, kClassID)
  , mHandlingInputEvent(false)
{
}

void
nsNumberControlFrame::DestroyFrom(nsIFrame* aDestructRoot, PostDestroyData& aPostDestroyData)
{
  NS_ASSERTION(!GetPrevContinuation() && !GetNextContinuation(),
               "nsNumberControlFrame should not have continuations; if it does we "
               "need to call RegUnregAccessKey only for the first");
  nsCheckboxRadioFrame::RegUnRegAccessKey(static_cast<nsIFrame*>(this), false);
  aPostDestroyData.AddAnonymousContent(mOuterWrapper.forget());
  nsContainerFrame::DestroyFrom(aDestructRoot, aPostDestroyData);
}

nscoord
nsNumberControlFrame::GetMinISize(gfxContext* aRenderingContext)
{
  nscoord result;
  DISPLAY_MIN_WIDTH(this, result);

  nsIFrame* kid = mFrames.FirstChild();
  if (kid) { // display:none?
    result = nsLayoutUtils::IntrinsicForContainer(aRenderingContext,
                                                  kid,
                                                  nsLayoutUtils::MIN_ISIZE);
  } else {
    result = 0;
  }

  return result;
}

nscoord
nsNumberControlFrame::GetPrefISize(gfxContext* aRenderingContext)
{
  nscoord result;
  DISPLAY_PREF_WIDTH(this, result);

  nsIFrame* kid = mFrames.FirstChild();
  if (kid) { // display:none?
    result = nsLayoutUtils::IntrinsicForContainer(aRenderingContext,
                                                  kid,
                                                  nsLayoutUtils::PREF_ISIZE);
  } else {
    result = 0;
  }

  return result;
}

void
nsNumberControlFrame::Reflow(nsPresContext* aPresContext,
                             ReflowOutput& aDesiredSize,
                             const ReflowInput& aReflowInput,
                             nsReflowStatus& aStatus)
{
  MarkInReflow();
  DO_GLOBAL_REFLOW_COUNT("nsNumberControlFrame");
  DISPLAY_REFLOW(aPresContext, this, aReflowInput, aDesiredSize, aStatus);
  MOZ_ASSERT(aStatus.IsEmpty(), "Caller should pass a fresh reflow status!");

  NS_ASSERTION(mOuterWrapper, "Outer wrapper div must exist!");

  NS_ASSERTION(!GetPrevContinuation() && !GetNextContinuation(),
               "nsNumberControlFrame should not have continuations; if it does we "
               "need to call RegUnregAccessKey only for the first");

  NS_ASSERTION(!mFrames.FirstChild() ||
               !mFrames.FirstChild()->GetNextSibling(),
               "We expect at most one direct child frame");

  if (mState & NS_FRAME_FIRST_REFLOW) {
    nsCheckboxRadioFrame::RegUnRegAccessKey(this, true);
  }

  const WritingMode myWM = aReflowInput.GetWritingMode();

  // The ISize of our content box, which is the available ISize
  // for our anonymous content:
  const nscoord contentBoxISize = aReflowInput.ComputedISize();
  nscoord contentBoxBSize = aReflowInput.ComputedBSize();

  // Figure out our border-box sizes as well (by adding borderPadding to
  // content-box sizes):
  const nscoord borderBoxISize = contentBoxISize +
    aReflowInput.ComputedLogicalBorderPadding().IStartEnd(myWM);

  nscoord borderBoxBSize;
  if (contentBoxBSize != NS_INTRINSICSIZE) {
    borderBoxBSize = contentBoxBSize +
      aReflowInput.ComputedLogicalBorderPadding().BStartEnd(myWM);
  } // else, we'll figure out borderBoxBSize after we resolve contentBoxBSize.

  nsIFrame* outerWrapperFrame = mOuterWrapper->GetPrimaryFrame();

  if (!outerWrapperFrame) { // display:none?
    if (contentBoxBSize == NS_INTRINSICSIZE) {
      contentBoxBSize = 0;
      borderBoxBSize =
        aReflowInput.ComputedLogicalBorderPadding().BStartEnd(myWM);
    }
  } else {
    NS_ASSERTION(outerWrapperFrame == mFrames.FirstChild(), "huh?");

    ReflowOutput wrappersDesiredSize(aReflowInput);

    WritingMode wrapperWM = outerWrapperFrame->GetWritingMode();
    LogicalSize availSize = aReflowInput.ComputedSize(wrapperWM);
    availSize.BSize(wrapperWM) = NS_UNCONSTRAINEDSIZE;

    ReflowInput wrapperReflowInput(aPresContext, aReflowInput,
                                         outerWrapperFrame, availSize);

    // Convert wrapper margin into my own writing-mode (in case it differs):
    LogicalMargin wrapperMargin =
      wrapperReflowInput.ComputedLogicalMargin().ConvertTo(myWM, wrapperWM);

    // offsets of wrapper frame within this frame:
    LogicalPoint
      wrapperOffset(myWM,
                    aReflowInput.ComputedLogicalBorderPadding().IStart(myWM) +
                    wrapperMargin.IStart(myWM),
                    aReflowInput.ComputedLogicalBorderPadding().BStart(myWM) +
                    wrapperMargin.BStart(myWM));

    nsReflowStatus childStatus;
    // We initially reflow the child with a dummy containerSize; positioning
    // will be fixed later.
    const nsSize dummyContainerSize;
    ReflowChild(outerWrapperFrame, aPresContext, wrappersDesiredSize,
                wrapperReflowInput, myWM, wrapperOffset, dummyContainerSize, 0,
                childStatus);
    MOZ_ASSERT(childStatus.IsFullyComplete(),
               "We gave our child unconstrained available block-size, "
               "so it should be complete");

    nscoord wrappersMarginBoxBSize =
      wrappersDesiredSize.BSize(myWM) + wrapperMargin.BStartEnd(myWM);

    if (contentBoxBSize == NS_INTRINSICSIZE) {
      // We are intrinsically sized -- we should shrinkwrap the outer wrapper's
      // block-size:
      contentBoxBSize = wrappersMarginBoxBSize;

      // Make sure we obey min/max-bsize in the case when we're doing intrinsic
      // sizing (we get it for free when we have a non-intrinsic
      // aReflowInput.ComputedBSize()).  Note that we do this before
      // adjusting for borderpadding, since ComputedMaxBSize and
      // ComputedMinBSize are content heights.
      contentBoxBSize =
        NS_CSS_MINMAX(contentBoxBSize,
                      aReflowInput.ComputedMinBSize(),
                      aReflowInput.ComputedMaxBSize());

      borderBoxBSize = contentBoxBSize +
        aReflowInput.ComputedLogicalBorderPadding().BStartEnd(myWM);
    }

    // Center child in block axis
    nscoord extraSpace = contentBoxBSize - wrappersMarginBoxBSize;
    wrapperOffset.B(myWM) += std::max(0, extraSpace / 2);

    // Needed in FinishReflowChild, for logical-to-physical conversion:
    nsSize borderBoxSize = LogicalSize(myWM, borderBoxISize, borderBoxBSize).
                           GetPhysicalSize(myWM);

    // Place the child
    FinishReflowChild(outerWrapperFrame, aPresContext, wrappersDesiredSize,
                      &wrapperReflowInput, myWM, wrapperOffset,
                      borderBoxSize, 0);

    nsSize contentBoxSize =
      LogicalSize(myWM, contentBoxISize, contentBoxBSize).
        GetPhysicalSize(myWM);
    aDesiredSize.SetBlockStartAscent(
       wrappersDesiredSize.BlockStartAscent() +
       outerWrapperFrame->BStart(aReflowInput.GetWritingMode(),
                                 contentBoxSize));
  }

  LogicalSize logicalDesiredSize(myWM, borderBoxISize, borderBoxBSize);
  aDesiredSize.SetSize(myWM, logicalDesiredSize);

  aDesiredSize.SetOverflowAreasToDesiredBounds();

  if (outerWrapperFrame) {
    ConsiderChildOverflow(aDesiredSize.mOverflowAreas, outerWrapperFrame);
  }

  FinishAndStoreOverflow(&aDesiredSize);

  MOZ_ASSERT(aStatus.IsEmpty(), "This type of frame can't be split.");

  NS_FRAME_SET_TRUNCATION(aStatus, aReflowInput, aDesiredSize);
}

void
nsNumberControlFrame::SyncDisabledState()
{
  EventStates eventStates = mContent->AsElement()->State();
  if (eventStates.HasState(NS_EVENT_STATE_DISABLED)) {
    mTextField->SetAttr(kNameSpaceID_None, nsGkAtoms::disabled, EmptyString(),
                        true);
  } else {
    mTextField->UnsetAttr(kNameSpaceID_None, nsGkAtoms::disabled, true);
  }
}

nsresult
nsNumberControlFrame::AttributeChanged(int32_t  aNameSpaceID,
                                       nsAtom* aAttribute,
                                       int32_t  aModType)
{
  // nsGkAtoms::disabled is handled by SyncDisabledState
  if (aNameSpaceID == kNameSpaceID_None) {
    if (aAttribute == nsGkAtoms::placeholder ||
        aAttribute == nsGkAtoms::readonly ||
        aAttribute == nsGkAtoms::tabindex) {
      if (aModType == MutationEvent_Binding::REMOVAL) {
        mTextField->UnsetAttr(aNameSpaceID, aAttribute, true);
      } else {
        MOZ_ASSERT(aModType == MutationEvent_Binding::ADDITION ||
                   aModType == MutationEvent_Binding::MODIFICATION);
        nsAutoString value;
        mContent->AsElement()->GetAttr(aNameSpaceID, aAttribute, value);
        mTextField->SetAttr(aNameSpaceID, aAttribute, value, true);
      }
    }
  }

  return nsContainerFrame::AttributeChanged(aNameSpaceID, aAttribute,
                                            aModType);
}

void
nsNumberControlFrame::ContentStatesChanged(EventStates aStates)
{
  if (aStates.HasState(NS_EVENT_STATE_DISABLED)) {
    nsContentUtils::AddScriptRunner(new SyncDisabledStateEvent(this));
  }
}

nsITextControlFrame*
nsNumberControlFrame::GetTextFieldFrame()
{
  return do_QueryFrame(GetAnonTextControl()->GetPrimaryFrame());
}

class FocusTextField : public Runnable
{
public:
  FocusTextField(nsIContent* aNumber, nsIContent* aTextField)
    : mozilla::Runnable("FocusTextField")
    , mNumber(aNumber)
    , mTextField(aTextField)
  {}

  NS_IMETHOD Run() override
  {
    if (mNumber->AsElement()->State().HasState(NS_EVENT_STATE_FOCUS)) {
      HTMLInputElement::FromNode(mTextField)->Focus(IgnoreErrors());
    }

    return NS_OK;
  }

private:
  nsCOMPtr<nsIContent> mNumber;
  nsCOMPtr<nsIContent> mTextField;
};

already_AddRefed<Element>
nsNumberControlFrame::MakeAnonymousElement(Element* aParent,
                                           nsAtom* aTagName,
                                           CSSPseudoElementType aPseudoType)
{
  // Get the NodeInfoManager and tag necessary to create the anonymous divs.
  nsIDocument* doc = mContent->GetComposedDoc();
  RefPtr<Element> resultElement = doc->CreateHTMLElement(aTagName);
  resultElement->SetPseudoElementType(aPseudoType);

  if (aPseudoType == CSSPseudoElementType::mozNumberSpinDown ||
      aPseudoType == CSSPseudoElementType::mozNumberSpinUp) {
    resultElement->SetAttr(kNameSpaceID_None, nsGkAtoms::role,
                           NS_LITERAL_STRING("button"), false);
  }

  if (aParent) {
    aParent->AppendChildTo(resultElement, false);
  }

  return resultElement.forget();
}

nsresult
nsNumberControlFrame::CreateAnonymousContent(nsTArray<ContentInfo>& aElements)
{
  // We create an anonymous tree for our input element that is structured as
  // follows:
  //
  // input
  //   div      - outer wrapper with "display:flex" by default
  //     input  - text input field
  //     div    - spin box wrapping up/down arrow buttons
  //       div  - spin up (up arrow button)
  //       div  - spin down (down arrow button)
  //
  // If you change this, be careful to change the destruction order in
  // nsNumberControlFrame::DestroyFrom.


  // Create the anonymous outer wrapper:
  mOuterWrapper = MakeAnonymousElement(nullptr,
                                       nsGkAtoms::div,
                                       CSSPseudoElementType::mozNumberWrapper);

  aElements.AppendElement(mOuterWrapper);

  // Create the ::-moz-number-text pseudo-element:
  mTextField = MakeAnonymousElement(mOuterWrapper,
                                    nsGkAtoms::input,
                                    CSSPseudoElementType::mozNumberText);

  mTextField->SetAttr(kNameSpaceID_None, nsGkAtoms::type,
                      NS_LITERAL_STRING("text"), false);

  HTMLInputElement* content = HTMLInputElement::FromNode(mContent);
  HTMLInputElement* textField = HTMLInputElement::FromNode(mTextField);

  // Initialize the text field value:
  nsAutoString value;
  content->GetValue(value, CallerType::System);
  SetValueOfAnonTextControl(value);

  // If we're readonly, make sure our anonymous text control is too:
  nsAutoString readonly;
  if (mContent->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::readonly,
                                     readonly)) {
    mTextField->SetAttr(kNameSpaceID_None, nsGkAtoms::readonly, readonly, false);
  }

  // Propogate our tabindex:
  textField->SetTabIndex(content->TabIndex(), IgnoreErrors());

  // Initialize the text field's placeholder, if ours is set:
  nsAutoString placeholder;
  if (mContent->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::placeholder,
                                     placeholder)) {
    mTextField->SetAttr(kNameSpaceID_None, nsGkAtoms::placeholder, placeholder, false);
  }

  if (mContent->AsElement()->State().HasState(NS_EVENT_STATE_FOCUS)) {
    // We don't want to focus the frame but the text field.
    RefPtr<FocusTextField> focusJob = new FocusTextField(mContent, mTextField);
    nsContentUtils::AddScriptRunner(focusJob);
  }

  SyncDisabledState(); // Sync disabled state of 'mTextField'.

  if (StyleDisplay()->mAppearance == StyleAppearance::Textfield) {
    // The author has elected to hide the spinner by setting this
    // -moz-appearance. We will reframe if it changes.
    return NS_OK;
  }

  // Create the ::-moz-number-spin-box pseudo-element:
  mSpinBox = MakeAnonymousElement(mOuterWrapper,
                                  nsGkAtoms::div,
                                  CSSPseudoElementType::mozNumberSpinBox);

  // Create the ::-moz-number-spin-up pseudo-element:
  mSpinUp = MakeAnonymousElement(mSpinBox,
                                 nsGkAtoms::div,
                                 CSSPseudoElementType::mozNumberSpinUp);

  // Create the ::-moz-number-spin-down pseudo-element:
  mSpinDown = MakeAnonymousElement(mSpinBox,
                                   nsGkAtoms::div,
                                   CSSPseudoElementType::mozNumberSpinDown);

  return NS_OK;
}

void
nsNumberControlFrame::SetFocus(bool aOn, bool aRepaint)
{
  GetTextFieldFrame()->SetFocus(aOn, aRepaint);
}

nsresult
nsNumberControlFrame::SetFormProperty(nsAtom* aName, const nsAString& aValue)
{
  return GetTextFieldFrame()->SetFormProperty(aName, aValue);
}

HTMLInputElement*
nsNumberControlFrame::GetAnonTextControl()
{
  return HTMLInputElement::FromNode(mTextField);
}

/* static */ nsNumberControlFrame*
nsNumberControlFrame::GetNumberControlFrameForTextField(nsIFrame* aFrame)
{
  // If aFrame is the anon text field for an <input type=number> then we expect
  // the frame of its mContent's grandparent to be that input's frame. We
  // have to check for this via the content tree because we don't know whether
  // extra frames will be wrapped around any of the elements between aFrame and
  // the nsNumberControlFrame that we're looking for (e.g. flex wrappers).
  nsIContent* content = aFrame->GetContent();
  if (content->IsInNativeAnonymousSubtree() &&
      content->GetParent() && content->GetParent()->GetParent()) {
    nsIContent* grandparent = content->GetParent()->GetParent();
    if (grandparent->IsHTMLElement(nsGkAtoms::input) &&
        grandparent->AsElement()->AttrValueIs(kNameSpaceID_None,
                                              nsGkAtoms::type,
                                              nsGkAtoms::number,
                                              eCaseMatters)) {
      return do_QueryFrame(grandparent->GetPrimaryFrame());
    }
  }
  return nullptr;
}

/* static */ nsNumberControlFrame*
nsNumberControlFrame::GetNumberControlFrameForSpinButton(nsIFrame* aFrame)
{
  // If aFrame is a spin button for an <input type=number> then we expect the
  // frame of its mContent's great-grandparent to be that input's frame. We
  // have to check for this via the content tree because we don't know whether
  // extra frames will be wrapped around any of the elements between aFrame and
  // the nsNumberControlFrame that we're looking for (e.g. flex wrappers).
  nsIContent* content = aFrame->GetContent();
  if (content->IsInNativeAnonymousSubtree() &&
      content->GetParent() && content->GetParent()->GetParent() &&
      content->GetParent()->GetParent()->GetParent()) {
    nsIContent* greatgrandparent = content->GetParent()->GetParent()->GetParent();
    if (greatgrandparent->IsHTMLElement(nsGkAtoms::input) &&
        greatgrandparent->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                   nsGkAtoms::type,
                                                   nsGkAtoms::number,
                                                   eCaseMatters)) {
      return do_QueryFrame(greatgrandparent->GetPrimaryFrame());
    }
  }
  return nullptr;
}

int32_t
nsNumberControlFrame::GetSpinButtonForPointerEvent(WidgetGUIEvent* aEvent) const
{
  MOZ_ASSERT(aEvent->mClass == eMouseEventClass, "Unexpected event type");

  if (!mSpinBox) {
    // we don't have a spinner
    return eSpinButtonNone;
  }
  if (aEvent->mOriginalTarget == mSpinUp) {
    return eSpinButtonUp;
  }
  if (aEvent->mOriginalTarget == mSpinDown) {
    return eSpinButtonDown;
  }
  if (aEvent->mOriginalTarget == mSpinBox) {
    // In the case that the up/down buttons are hidden (display:none) we use
    // just the spin box element, spinning up if the pointer is over the top
    // half of the element, or down if it's over the bottom half. This is
    // important to handle since this is the state things are in for the
    // default UA style sheet. See the comment in forms.css for why.
    LayoutDeviceIntPoint absPoint = aEvent->mRefPoint;
    nsPoint point =
      nsLayoutUtils::GetEventCoordinatesRelativeTo(aEvent,
                       absPoint, mSpinBox->GetPrimaryFrame());
    if (point != nsPoint(NS_UNCONSTRAINEDSIZE, NS_UNCONSTRAINEDSIZE)) {
      if (point.y < mSpinBox->GetPrimaryFrame()->GetSize().height / 2) {
        return eSpinButtonUp;
      }
      return eSpinButtonDown;
    }
  }
  return eSpinButtonNone;
}

void
nsNumberControlFrame::SpinnerStateChanged() const
{
  MOZ_ASSERT(mSpinUp && mSpinDown,
             "We should not be called when we have no spinner");

  nsIFrame* spinUpFrame = mSpinUp->GetPrimaryFrame();
  if (spinUpFrame && spinUpFrame->IsThemed()) {
    spinUpFrame->InvalidateFrame();
  }
  nsIFrame* spinDownFrame = mSpinDown->GetPrimaryFrame();
  if (spinDownFrame && spinDownFrame->IsThemed()) {
    spinDownFrame->InvalidateFrame();
  }
}

bool
nsNumberControlFrame::SpinnerUpButtonIsDepressed() const
{
  return HTMLInputElement::FromNode(mContent)->
           NumberSpinnerUpButtonIsDepressed();
}

bool
nsNumberControlFrame::SpinnerDownButtonIsDepressed() const
{
  return HTMLInputElement::FromNode(mContent)->
           NumberSpinnerDownButtonIsDepressed();
}

bool
nsNumberControlFrame::IsFocused() const
{
  // Normally this depends on the state of our anonymous text control (which
  // takes focus for us), but in the case that it does not have a frame we will
  // have focus ourself.
  return mTextField->State().HasState(NS_EVENT_STATE_FOCUS) ||
         mContent->AsElement()->State().HasState(NS_EVENT_STATE_FOCUS);
}

void
nsNumberControlFrame::HandleFocusEvent(WidgetEvent* aEvent)
{
  if (aEvent->mOriginalTarget != mTextField) {
    // Move focus to our text field
    RefPtr<HTMLInputElement> textField = HTMLInputElement::FromNode(mTextField);
    textField->Focus(IgnoreErrors());
  }
}

void
nsNumberControlFrame::HandleSelectCall()
{
  RefPtr<HTMLInputElement> textField = HTMLInputElement::FromNode(mTextField);
  textField->Select();
}

#define STYLES_DISABLING_NATIVE_THEMING \
  NS_AUTHOR_SPECIFIED_BACKGROUND | \
  NS_AUTHOR_SPECIFIED_PADDING | \
  NS_AUTHOR_SPECIFIED_BORDER

bool
nsNumberControlFrame::ShouldUseNativeStyleForSpinner() const
{
  MOZ_ASSERT(mSpinUp && mSpinDown,
             "We should not be called when we have no spinner");

  nsIFrame* spinUpFrame = mSpinUp->GetPrimaryFrame();
  nsIFrame* spinDownFrame = mSpinDown->GetPrimaryFrame();

  return spinUpFrame &&
    spinUpFrame->StyleDisplay()->mAppearance == StyleAppearance::SpinnerUpbutton &&
    !PresContext()->HasAuthorSpecifiedRules(spinUpFrame,
                                            STYLES_DISABLING_NATIVE_THEMING) &&
    spinDownFrame &&
    spinDownFrame->StyleDisplay()->mAppearance == StyleAppearance::SpinnerDownbutton &&
    !PresContext()->HasAuthorSpecifiedRules(spinDownFrame,
                                            STYLES_DISABLING_NATIVE_THEMING);
}

void
nsNumberControlFrame::AppendAnonymousContentTo(nsTArray<nsIContent*>& aElements,
                                               uint32_t aFilter)
{
  // Only one direct anonymous child:
  if (mOuterWrapper) {
    aElements.AppendElement(mOuterWrapper);
  }
}

void
nsNumberControlFrame::SetValueOfAnonTextControl(const nsAString& aValue)
{
  if (mHandlingInputEvent) {
    // We have been called while our HTMLInputElement is processing a DOM
    // 'input' event targeted at our anonymous text control. Our
    // HTMLInputElement has taken the value of our anon text control and
    // called SetValueInternal on itself to keep its own value in sync. As a
    // result SetValueInternal has called us. In this one case we do not want
    // to update our anon text control, especially since aValue will be the
    // sanitized value, and only the internal value should be sanitized (not
    // the value shown to the user, and certainly we shouldn't change it as
    // they type).
    return;
  }

  // Init to aValue so that we set aValue as the value of our text control if
  // aValue isn't a valid number (in which case the HTMLInputElement's validity
  // state will be set to invalid) or if aValue can't be localized:
  nsAutoString localizedValue(aValue);

  // Try and localize the value we will set:
  Decimal val = HTMLInputElement::StringToDecimal(aValue);
  if (val.isFinite()) {
    ICUUtils::LanguageTagIterForContent langTagIter(mContent);
    ICUUtils::LocalizeNumber(val.toDouble(), langTagIter, localizedValue);
  }

  // We need to update the value of our anonymous text control here. Note that
  // this must be its value, and not its 'value' attribute (the default value),
  // since the default value is ignored once a user types into the text
  // control.
  //
  // Pass NonSystem as the caller type; this should work fine for actual number
  // inputs, and be safe in case our input has a type we don't expect for some
  // reason.
  HTMLInputElement::FromNode(mTextField)->SetValue(localizedValue,
                                                   CallerType::NonSystem,
                                                   IgnoreErrors());
}

void
nsNumberControlFrame::GetValueOfAnonTextControl(nsAString& aValue)
{
  if (!mTextField) {
    aValue.Truncate();
    return;
  }

  HTMLInputElement::FromNode(mTextField)->GetValue(aValue, CallerType::System);

  // Here we need to de-localize any number typed in by the user. That is, we
  // need to convert it from the number format of the user's language, region,
  // etc. to the format that the HTML 5 spec defines to be a "valid
  // floating-point number":
  //
  //   http://www.whatwg.org/specs/web-apps/current-work/multipage/common-microsyntaxes.html#floating-point-numbers
  //
  // This is necessary to allow the number that we return to be parsed by
  // functions like HTMLInputElement::StringToDecimal (the HTML-5-conforming
  // parsing function) which don't know how to handle numbers that are
  // formatted differently (for example, with non-ASCII digits, with grouping
  // separator characters or with a decimal separator character other than
  // '.').

  ICUUtils::LanguageTagIterForContent langTagIter(mContent);
  double value = ICUUtils::ParseNumber(aValue, langTagIter);
  if (!IsFinite(value)) {
    aValue.Truncate();
    return;
  }
  if (value == HTMLInputElement::StringToDecimal(aValue).toDouble()) {
    // We want to preserve the formatting of the number as typed in by the user
    // whenever possible. Since the localized serialization parses to the same
    // number as the de-localized serialization, we can do that. This helps
    // prevent normalization of input such as "2e2" (which would otherwise be
    // converted to "200"). Content relies on this.
    //
    // Typically we will only get here for locales in which numbers are
    // formatted in the same way as they are for HTML5's "valid floating-point
    // number" format.
    return;
  }
  // We can't preserve the formatting, otherwise functions such as
  // HTMLInputElement::StringToDecimal would incorrectly process the number
  // input by the user. For example, "12.345" with lang=de de-localizes as
  // 12345, but HTMLInputElement::StringToDecimal would mistakenly parse it as
  // 12.345. Another example would be "12,345" with lang=de which de-localizes
  // as 12.345, but HTMLInputElement::StringToDecimal would parse it to NaN.
  aValue.Truncate();
  aValue.AppendFloat(value);
}

bool
nsNumberControlFrame::AnonTextControlIsEmpty()
{
  if (!mTextField) {
    return true;
  }
  nsAutoString value;
  HTMLInputElement::FromNode(mTextField)->GetValue(value, CallerType::System);
  return value.IsEmpty();
}

#ifdef ACCESSIBILITY
a11y::AccType
nsNumberControlFrame::AccessibleType()
{
  return a11y::eHTMLSpinnerType;
}
#endif
