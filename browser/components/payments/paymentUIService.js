/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Singleton service acting as glue between the DOM APIs and the payment dialog UI.
 *
 * Communication from the DOM to the UI happens via the nsIPaymentUIService interface.
 * The UI talks to the DOM code via the nsIPaymentRequestService interface.
 * PaymentUIService is started by the DOM code lazily.
 *
 * For now the UI is shown in a native dialog but that is likely to change.
 * Tests should try to avoid relying on that implementation detail.
 */

"use strict";

ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyServiceGetter(this,
                                   "paymentSrv",
                                   "@mozilla.org/dom/payments/payment-request-service;1",
                                   "nsIPaymentRequestService");

function PaymentUIService() {
  this.wrappedJSObject = this;
  XPCOMUtils.defineLazyGetter(this, "log", () => {
    let {ConsoleAPI} = ChromeUtils.import("resource://gre/modules/Console.jsm", {});
    return new ConsoleAPI({
      maxLogLevelPref: "dom.payments.loglevel",
      prefix: "Payment UI Service",
    });
  });
  Services.wm.addListener(this);
  this.log.debug("constructor");
}

PaymentUIService.prototype = {
  classID: Components.ID("{01f8bd55-9017-438b-85ec-7c15d2b35cdc}"),
  QueryInterface: ChromeUtils.generateQI([Ci.nsIPaymentUIService]),
  DIALOG_URL: "chrome://payments/content/paymentDialogWrapper.xul",
  REQUEST_ID_PREFIX: "paymentRequest-",

  // nsIWindowMediatorListener implementation:

  onOpenWindow(aWindow) {},
  onCloseWindow(aWindow) {
    let domWindow = aWindow.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindow);
    let requestId = this.requestIdForWindow(domWindow);
    if (!requestId || !paymentSrv.getPaymentRequestById(requestId)) {
      return;
    }
    this.log.debug(`onCloseWindow, close of window for active requestId: ${requestId}`);
    this.rejectPaymentForClosedDialog(requestId);
  },

  // nsIPaymentUIService implementation:

  showPayment(requestId) {
    this.log.debug("showPayment:", requestId);
    let chromeWindow = Services.wm.getMostRecentWindow("navigator:browser");
    chromeWindow.openDialog(`${this.DIALOG_URL}?requestId=${requestId}`,
                            `${this.REQUEST_ID_PREFIX}${requestId}`,
                            "modal,dialog,centerscreen,resizable=no");
  },

  abortPayment(requestId) {
    this.log.debug("abortPayment:", requestId);
    let abortResponse = Cc["@mozilla.org/dom/payments/payment-abort-action-response;1"]
                          .createInstance(Ci.nsIPaymentAbortActionResponse);
    let found = this.closeDialog(requestId);

    // if `win` is falsy, then we haven't found the dialog, so the abort fails
    // otherwise, the abort is successful
    let response = found ?
      Ci.nsIPaymentActionResponse.ABORT_SUCCEEDED :
      Ci.nsIPaymentActionResponse.ABORT_FAILED;

    abortResponse.init(requestId, response);
    paymentSrv.respondPayment(abortResponse);
  },

  rejectPaymentForClosedDialog(requestId) {
    this.log.debug("rejectPaymentForClosedDialog:", requestId);
    const rejectResponse = Cc["@mozilla.org/dom/payments/payment-show-action-response;1"]
                            .createInstance(Ci.nsIPaymentShowActionResponse);
    rejectResponse.init(requestId,
                        Ci.nsIPaymentActionResponse.PAYMENT_REJECTED,
                        "", // payment method
                        null, // payment method data
                        "", // payer name
                        "", // payer email
                        "");// payer phone
    paymentSrv.respondPayment(rejectResponse);
  },

  completePayment(requestId) {
    // completeStatus should be one of "timeout", "success", "fail", ""
    let {completeStatus} = paymentSrv.getPaymentRequestById(requestId);
    this.log.debug(`completePayment: requestId: ${requestId}, completeStatus: ${completeStatus}`);

    let closed;
    switch (completeStatus) {
      case "fail":
      case "timeout":
        break;
      default:
        closed = this.closeDialog(requestId);
        break;
    }
    let responseCode = closed ?
        Ci.nsIPaymentActionResponse.COMPLETE_SUCCEEDED :
        Ci.nsIPaymentActionResponse.COMPLETE_FAILED;
    let completeResponse = Cc["@mozilla.org/dom/payments/payment-complete-action-response;1"]
                             .createInstance(Ci.nsIPaymentCompleteActionResponse);
    completeResponse.init(requestId, responseCode);
    paymentSrv.respondPayment(completeResponse.QueryInterface(Ci.nsIPaymentActionResponse));

    if (!closed) {
      let dialog = this.findDialog(requestId);
      if (!dialog) {
        this.log.error("completePayment: no dialog found");
        return;
      }
      dialog.paymentDialogWrapper.updateRequest();
    }
  },

  updatePayment(requestId) {
    let dialog = this.findDialog(requestId);
    this.log.debug("updatePayment:", requestId);
    if (!dialog) {
      this.log.error("updatePayment: no dialog found");
      return;
    }
    dialog.paymentDialogWrapper.updateRequest();
  },

  // other helper methods

  /**
   * @param {string} requestId - Payment Request ID of the dialog to close.
   * @returns {boolean} whether the specified dialog was closed.
   */
  closeDialog(requestId) {
    let win = this.findDialog(requestId);
    if (!win) {
      return false;
    }
    this.log.debug(`closing: ${win.name}`);
    win.close();
    return true;
  },

  findDialog(requestId) {
    for (let win of Services.wm.getEnumerator(null)) {
      if (win.name == `${this.REQUEST_ID_PREFIX}${requestId}`) {
        return win;
      }
    }

    return null;
  },

  requestIdForWindow(window) {
    let windowName = window.name;

    return windowName.startsWith(this.REQUEST_ID_PREFIX) ?
      windowName.replace(this.REQUEST_ID_PREFIX, "") : // returns suffix, which is the requestId
      null;
  },
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([PaymentUIService]);
