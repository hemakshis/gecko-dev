/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsCOMPtr.h"
#include "nsIPresShell.h"
#include "nsIContent.h"
#include "nsNameSpaceManager.h"
#include "nsGkAtoms.h"
#include "nsMenuPopupFrame.h"
#include "nsView.h"
#include "mozilla/AppUnits.h"
#include "mozilla/dom/DOMRect.h"
#include "mozilla/dom/Element.h"
#include "mozilla/dom/Event.h"
#include "mozilla/dom/XULPopupElement.h"
#include "mozilla/dom/XULPopupElementBinding.h"

namespace mozilla {
namespace dom {

nsXULElement*
NS_NewXULPopupElement(already_AddRefed<mozilla::dom::NodeInfo>&& aNodeInfo)
{
  return new XULPopupElement(aNodeInfo);
}

JSObject*
XULPopupElement::WrapNode(JSContext *aCx, JS::Handle<JSObject*> aGivenProto)
{
  return XULPopupElement_Binding::Wrap(aCx, this, aGivenProto);
}

nsIFrame*
XULPopupElement::GetFrame(bool aFlushLayout)
{
  nsCOMPtr<nsIContent> kungFuDeathGrip = this; // keep a reference

  nsCOMPtr<nsIDocument> doc = GetUncomposedDoc();
  if (doc) {
    doc->FlushPendingNotifications(aFlushLayout ? FlushType::Layout : FlushType::Frames);
  }

  return GetPrimaryFrame();
}

void
XULPopupElement::OpenPopup(Element* aAnchorElement,
                           const StringOrOpenPopupOptions& aOptions,
                           int32_t aXPos, int32_t aYPos,
                           bool aIsContextMenu,
                           bool aAttributesOverride,
                           Event* aTriggerEvent)
{
  nsAutoString position;
  if (aOptions.IsOpenPopupOptions()) {
    const OpenPopupOptions& options = aOptions.GetAsOpenPopupOptions();
    position = options.mPosition;
    aXPos = options.mX;
    aYPos = options.mY;
    aIsContextMenu = options.mIsContextMenu;
    aAttributesOverride = options.mAttributesOverride;
    aTriggerEvent = options.mTriggerEvent;
  }
  else {
    position = aOptions.GetAsString();
  }

  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (pm) {
    // As a special case for popups that are menus when no anchor or position are
    // specified, open the popup with ShowMenu instead of ShowPopup so that the
    // popup is aligned with the menu.
    if (!aAnchorElement && position.IsEmpty() && GetPrimaryFrame()) {
      nsMenuFrame* menu = do_QueryFrame(GetPrimaryFrame()->GetParent());
      if (menu) {
        pm->ShowMenu(menu->GetContent(), false, false);
        return;
      }
    }

    pm->ShowPopup(this, aAnchorElement, position, aXPos, aYPos,
                  aIsContextMenu, aAttributesOverride, false, aTriggerEvent);
  }
}

void
XULPopupElement::OpenPopupAtScreen(int32_t aXPos, int32_t aYPos,
                                   bool aIsContextMenu,
                                   Event* aTriggerEvent)
{
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (pm) {
    pm->ShowPopupAtScreen(this, aXPos, aYPos, aIsContextMenu, aTriggerEvent);
  }
}

void
XULPopupElement::OpenPopupAtScreenRect(const nsAString& aPosition,
                                       int32_t aXPos, int32_t aYPos,
                                       int32_t aWidth, int32_t aHeight,
                                       bool aIsContextMenu,
                                       bool aAttributesOverride,
                                       Event* aTriggerEvent)
{
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (pm) {
    pm->ShowPopupAtScreenRect(this, aPosition,
                              nsIntRect(aXPos, aYPos, aWidth, aHeight),
                              aIsContextMenu, aAttributesOverride, aTriggerEvent);
  }
}

void
XULPopupElement::HidePopup(bool aCancel)
{
  nsXULPopupManager* pm = nsXULPopupManager::GetInstance();
  if (pm) {
    pm->HidePopup(this, false, true, false, aCancel);
  }
}

void
XULPopupElement::MoveTo(int32_t aLeft, int32_t aTop)
{
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetPrimaryFrame());
  if (menuPopupFrame) {
    menuPopupFrame->MoveTo(CSSIntPoint(aLeft, aTop), true);
  }
}

void
XULPopupElement::MoveToAnchor(Element* aAnchorElement,
                              const nsAString& aPosition,
                              int32_t aXPos, int32_t aYPos,
                              bool aAttributesOverride)
{
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetPrimaryFrame());
  if (menuPopupFrame && menuPopupFrame->IsVisible()) {
    menuPopupFrame->MoveToAnchor(aAnchorElement, aPosition, aXPos, aYPos, aAttributesOverride);
  }
}

void
XULPopupElement::SizeTo(int32_t aWidth, int32_t aHeight)
{
  nsAutoString width, height;
  width.AppendInt(aWidth);
  height.AppendInt(aHeight);

  nsCOMPtr<nsIContent> kungFuDeathGrip = this; // keep a reference

  // We only want to pass aNotify=true to SetAttr once, but must make sure
  // we pass it when a value is being changed.  Thus, we check if the height
  // is the same and if so, pass true when setting the width.
  bool heightSame = AttrValueIs(kNameSpaceID_None, nsGkAtoms::height, height, eCaseMatters);

  SetAttr(kNameSpaceID_None, nsGkAtoms::width, width, heightSame);
  SetAttr(kNameSpaceID_None, nsGkAtoms::height, height, true);

  // If the popup is open, force a reposition of the popup after resizing it
  // with notifications set to true so that the popuppositioned event is fired.
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetPrimaryFrame());
  if (menuPopupFrame && menuPopupFrame->PopupState() == ePopupShown) {
    menuPopupFrame->SetPopupPosition(nullptr, false, false, true);
  }
}

bool
XULPopupElement::AutoPosition()
{
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetPrimaryFrame());
  if (menuPopupFrame) {
    return menuPopupFrame->GetAutoPosition();
  }
  return true;
}

void
XULPopupElement::SetAutoPosition(bool aShouldAutoPosition)
{
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetPrimaryFrame());
  if (menuPopupFrame) {
    menuPopupFrame->SetAutoPosition(aShouldAutoPosition);
  }
}

void
XULPopupElement::GetState(nsString& aState)
{
  // set this here in case there's no frame for the popup
  aState.AssignLiteral("closed");

  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetPrimaryFrame());
  if (menuPopupFrame) {
    switch (menuPopupFrame->PopupState()) {
      case ePopupShown:
        aState.AssignLiteral("open");
        break;
      case ePopupShowing:
      case ePopupPositioning:
      case ePopupOpening:
      case ePopupVisible:
        aState.AssignLiteral("showing");
        break;
      case ePopupHiding:
      case ePopupInvisible:
        aState.AssignLiteral("hiding");
        break;
      case ePopupClosed:
        break;
      default:
        MOZ_ASSERT_UNREACHABLE("Bad popup state");
        break;
    }
  }
}

nsINode*
XULPopupElement::GetTriggerNode() const
{
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetPrimaryFrame());
  return nsMenuPopupFrame::GetTriggerContent(menuPopupFrame);
}

// FIXME(emilio): should probably be renamed to GetAnchorElement?
Element*
XULPopupElement::GetAnchorNode() const
{
  nsMenuPopupFrame* menuPopupFrame = do_QueryFrame(GetPrimaryFrame());
  if (!menuPopupFrame) {
    return nullptr;
  }

  return Element::FromNodeOrNull(menuPopupFrame->GetAnchor());
}

already_AddRefed<DOMRect>
XULPopupElement::GetOuterScreenRect()
{
  RefPtr<DOMRect> rect = new DOMRect(ToSupports(this));

  // Return an empty rectangle if the popup is not open.
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetFrame(false));
  if (!menuPopupFrame || !menuPopupFrame->IsOpen()) {
    return rect.forget();
  }

  nsView* view = menuPopupFrame->GetView();
  if (view) {
    nsIWidget* widget = view->GetWidget();
    if (widget) {
      LayoutDeviceIntRect screenRect = widget->GetScreenBounds();

      int32_t pp = menuPopupFrame->PresContext()->AppUnitsPerDevPixel();
      rect->SetLayoutRect(LayoutDeviceIntRect::ToAppUnits(screenRect, pp));
    }
  }
  return rect.forget();
}

void
XULPopupElement::GetAlignmentPosition(nsString& positionStr)
{
  positionStr.Truncate();

  // This needs to flush layout.
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetFrame(true));
  if (!menuPopupFrame)
    return;

  int8_t position = menuPopupFrame->GetAlignmentPosition();
  switch (position) {
    case POPUPPOSITION_AFTERSTART:
      positionStr.AssignLiteral("after_start");
      break;
    case POPUPPOSITION_AFTEREND:
      positionStr.AssignLiteral("after_end");
      break;
    case POPUPPOSITION_BEFORESTART:
      positionStr.AssignLiteral("before_start");
      break;
    case POPUPPOSITION_BEFOREEND:
      positionStr.AssignLiteral("before_end");
      break;
    case POPUPPOSITION_STARTBEFORE:
      positionStr.AssignLiteral("start_before");
      break;
    case POPUPPOSITION_ENDBEFORE:
      positionStr.AssignLiteral("end_before");
      break;
    case POPUPPOSITION_STARTAFTER:
      positionStr.AssignLiteral("start_after");
      break;
    case POPUPPOSITION_ENDAFTER:
      positionStr.AssignLiteral("end_after");
      break;
    case POPUPPOSITION_OVERLAP:
      positionStr.AssignLiteral("overlap");
      break;
    case POPUPPOSITION_AFTERPOINTER:
      positionStr.AssignLiteral("after_pointer");
      break;
    case POPUPPOSITION_SELECTION:
      positionStr.AssignLiteral("selection");
      break;
    default:
      // Leave as an empty string.
      break;
  }
}

int32_t
XULPopupElement::AlignmentOffset()
{
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetFrame(false));
  if (!menuPopupFrame)
    return 0;

  int32_t pp = mozilla::AppUnitsPerCSSPixel();
  // Note that the offset might be along either the X or Y axis, but for the
  // sake of simplicity we use a point with only the X axis set so we can
  // use ToNearestPixels().
  nsPoint appOffset(menuPopupFrame->GetAlignmentOffset(), 0);
  nsIntPoint popupOffset = appOffset.ToNearestPixels(pp);
  return popupOffset.x;
}

void
XULPopupElement::SetConstraintRect(dom::DOMRectReadOnly& aRect)
{
  nsMenuPopupFrame *menuPopupFrame = do_QueryFrame(GetFrame(false));
  if (menuPopupFrame) {
    menuPopupFrame->SetOverrideConstraintRect(
      LayoutDeviceIntRect::Truncate(aRect.Left(), aRect.Top(), aRect.Width(), aRect.Height()));
  }
}

} // namespace dom
} // namespace mozilla
