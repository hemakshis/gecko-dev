/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/SVGAnimatedNumber.h"

#include "mozilla/dom/SVGAnimatedNumberBinding.h"

namespace mozilla {
namespace dom {

NS_SVG_VAL_IMPL_CYCLE_COLLECTION_WRAPPERCACHED(SVGAnimatedNumber,
                                               mSVGElement)

NS_IMPL_CYCLE_COLLECTING_ADDREF(SVGAnimatedNumber)
NS_IMPL_CYCLE_COLLECTING_RELEASE(SVGAnimatedNumber)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(SVGAnimatedNumber)
  NS_WRAPPERCACHE_INTERFACE_MAP_ENTRY
  NS_INTERFACE_MAP_ENTRY(nsISupports)
NS_INTERFACE_MAP_END

JSObject*
SVGAnimatedNumber::WrapObject(JSContext* aCx, JS::Handle<JSObject*> aGivenProto)
{
  return SVGAnimatedNumber_Binding::Wrap(aCx, this, aGivenProto);
}

} // namespace dom
} // namespace mozilla
