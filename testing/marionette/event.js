/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Provides functionality for creating and sending DOM events. */
this.event = {};

"use strict";
/* global content, is */

ChromeUtils.import("resource://gre/modules/Services.jsm");

ChromeUtils.import("chrome://marionette/content/element.js");

const dblclickTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

//  Max interval between two clicks that should result in a dblclick (in ms)
const DBLCLICK_INTERVAL = 640;

this.EXPORTED_SYMBOLS = ["event"];

// TODO(ato): Document!
let seenEvent = false;

function getDOMWindowUtils(win) {
  if (!win) {
    win = window;
  }

  // this assumes we are operating in chrome space
  return win.windowUtils;
}

event.MouseEvents = {
  click: 0,
  dblclick: 1,
  mousedown: 2,
  mouseup: 3,
  mouseover: 4,
  mouseout: 5,
};

event.Modifiers = {
  shiftKey: 0,
  ctrlKey: 1,
  altKey: 2,
  metaKey: 3,
};

event.MouseButton = {
  isPrimary(button) {
    return button === 0;
  },
  isAuxiliary(button) {
    return button === 1;
  },
  isSecondary(button) {
    return button === 2;
  },
};

event.DoubleClickTracker = {
  firstClick: false,
  isClicked() {
    return event.DoubleClickTracker.firstClick;
  },
  setClick() {
    if (!event.DoubleClickTracker.firstClick) {
      event.DoubleClickTracker.firstClick = true;
      event.DoubleClickTracker.startTimer();
    }
  },
  resetClick() {
    event.DoubleClickTracker.firstClick = false;
    event.DoubleClickTracker.cancelTimer();
  },
  startTimer() {
    dblclickTimer.initWithCallback(event.DoubleClickTracker.resetClick,
        DBLCLICK_INTERVAL, Ci.nsITimer.TYPE_ONE_SHOT);
  },
  cancelTimer() {
    dblclickTimer.cancel();
  },
};

/**
 * Sends a mouse event to given target.
 *
 * @param {MouseEvent} mouseEvent
 *     Event to send.
 * @param {(DOMElement|string)} target
 *     Target of event.  Can either be an element or the ID of an element.
 * @param {Window=} window
 *     Window object.  Defaults to the current window.
 *
 * @throws {TypeError}
 *     If the event is unsupported.
 */
event.sendMouseEvent = function(mouseEvent, target, window = undefined) {
  if (!event.MouseEvents.hasOwnProperty(mouseEvent.type)) {
    throw new TypeError("Unsupported event type: " + mouseEvent.type);
  }

  if (!target.nodeType && typeof target != "string") {
    throw new TypeError(
        "Target can only be a DOM element or a string: " + target);
  }

  if (!target.nodeType) {
    target = window.document.getElementById(target);
  } else {
    window = window || target.ownerGlobal;
  }

  let ev = window.document.createEvent("MouseEvent");

  let view = window;

  let detail = mouseEvent.detail;
  if (!detail) {
    if (mouseEvent.type in ["click", "mousedown", "mouseup"]) {
      detail = 1;
    } else if (mouseEvent.type == "dblclick") {
      detail = 2;
    } else {
      detail = 0;
    }
  }

  let screenX = mouseEvent.screenX || 0;
  let screenY = mouseEvent.screenY || 0;
  let clientX = mouseEvent.clientX || 0;
  let clientY = mouseEvent.clientY || 0;
  let ctrlKey = mouseEvent.ctrlKey || false;
  let altKey = mouseEvent.altKey || false;
  let shiftKey = mouseEvent.shiftKey || false;
  let metaKey = mouseEvent.metaKey || false;
  let button = mouseEvent.button || 0;
  let relatedTarget = mouseEvent.relatedTarget || null;

  ev.initMouseEvent(
      mouseEvent.type,
      /* canBubble */ true,
      /* cancelable */ true,
      view,
      detail,
      screenX,
      screenY,
      clientX,
      clientY,
      ctrlKey,
      altKey,
      shiftKey,
      metaKey,
      button,
      relatedTarget);
};

/**
 * Send character to the currently focused element.
 *
 * This function handles casing of characters (sends the right charcode,
 * and sends a shift key for uppercase chars).  No other modifiers are
 * handled at this point.
 *
 * For now this method only works for English letters (lower and upper
 * case) and the digits 0-9.
 */
event.sendChar = function(char, window = undefined) {
  // DOM event charcodes match ASCII (JS charcodes) for a-zA-Z0-9
  let hasShift = (char == char.toUpperCase());
  event.synthesizeKey(char, {shiftKey: hasShift}, window);
};

/**
 * Send string to the focused element.
 *
 * For now this method only works for English letters (lower and upper
 * case) and the digits 0-9.
 */
event.sendString = function(string, window = undefined) {
  for (let i = 0; i < string.length; ++i) {
    event.sendChar(string.charAt(i), window);
  }
};

/**
 * Send the non-character key to the focused element.
 *
 * The name of the key should be the part that comes after "DOM_VK_"
 * in the KeyboardEvent constant name for this key.  No modifiers are
 * handled at this point.
 */
event.sendKey = function(key, window = undefined) {
  let keyName = "VK_" + key.toUpperCase();
  event.synthesizeKey(keyName, {shiftKey: false}, window);
};

// TODO(ato): Unexpose this when action.Chain#emitMouseEvent
// no longer emits its own events
event.parseModifiers_ = function(modifiers) {
  let mval = 0;
  if (modifiers.shiftKey) {
    mval |= Ci.nsIDOMWindowUtils.MODIFIER_SHIFT;
  }
  if (modifiers.ctrlKey) {
    mval |= Ci.nsIDOMWindowUtils.MODIFIER_CONTROL;
  }
  if (modifiers.altKey) {
    mval |= Ci.nsIDOMWindowUtils.MODIFIER_ALT;
  }
  if (modifiers.metaKey) {
    mval |= Ci.nsIDOMWindowUtils.MODIFIER_META;
  }
  if (modifiers.accelKey) {
    if (Services.appinfo.OS === "Darwin") {
      mval |= Ci.nsIDOMWindowUtils.MODIFIER_META;
    } else {
      mval |= Ci.nsIDOMWindowUtils.MODIFIER_CONTROL;
    }
  }
  return mval;
};

/**
 * Synthesise a mouse event on a target.
 *
 * The actual client point is determined by taking the aTarget's client
 * box and offseting it by offsetX and offsetY.  This allows mouse clicks
 * to be simulated by calling this method.
 *
 * If the type is specified, an mouse event of that type is
 * fired. Otherwise, a mousedown followed by a mouse up is performed.
 *
 * @param {Element} element
 *     Element to click.
 * @param {number} offsetX
 *     Horizontal offset to click from the target's bounding box.
 * @param {number} offsetY
 *     Vertical offset to click from the target's bounding box.
 * @param {Object.<string, ?>} opts
 *     Object which may contain the properties "shiftKey", "ctrlKey",
 *     "altKey", "metaKey", "accessKey", "clickCount", "button", and
 *     "type".
 * @param {Window=} window
 *     Window object.  Defaults to the current window.
 */
event.synthesizeMouse = function(
    element, offsetX, offsetY, opts, window = undefined) {
  let rect = element.getBoundingClientRect();
  event.synthesizeMouseAtPoint(
      rect.left + offsetX, rect.top + offsetY, opts, window);
};

/*
 * Synthesize a mouse event at a particular point in a window.
 *
 * If the type of the event is specified, a mouse event of that type is
 * fired. Otherwise, a mousedown followed by a mouse up is performed.
 *
 * @param {number} left
 *     CSS pixels from the left document margin.
 * @param {number} top
 *     CSS pixels from the top document margin.
 * @param {Object.<string, ?>} opts
 *     Object which may contain the properties "shiftKey", "ctrlKey",
 *     "altKey", "metaKey", "accessKey", "clickCount", "button", and
 *     "type".
 * @param {Window=} win
 *     Window object.  Defaults to the current window.
 */
event.synthesizeMouseAtPoint = function(
    left, top, opts, win = window) {

  let domutils = getDOMWindowUtils(win);

  let button = opts.button || 0;
  let clickCount = opts.clickCount || 1;
  let modifiers = event.parseModifiers_(opts);
  let pressure = ("pressure" in opts) ? opts.pressure : 0;
  let inputSource = ("inputSource" in opts) ? opts.inputSource :
      win.MouseEvent.MOZ_SOURCE_MOUSE;
  let isDOMEventSynthesized =
      ("isSynthesized" in opts) ? opts.isSynthesized : true;
  let isWidgetEventSynthesized;
  if ("isWidgetEventSynthesized" in opts) {
    isWidgetEventSynthesized = opts.isWidgetEventSynthesized;
  } else {
    isWidgetEventSynthesized = false;
  }
  let buttons;
  if ("buttons" in opts) {
    buttons = opts.buttons;
  } else {
    buttons = domutils.MOUSE_BUTTONS_NOT_SPECIFIED;
  }

  if (("type" in opts) && opts.type) {
    domutils.sendMouseEvent(
        opts.type,
        left,
        top,
        button,
        clickCount,
        modifiers,
        false,
        pressure,
        inputSource,
        isDOMEventSynthesized,
        isWidgetEventSynthesized,
        buttons);
  } else {
    domutils.sendMouseEvent(
        "mousedown",
        left,
        top,
        button,
        clickCount,
        modifiers,
        false,
        pressure,
        inputSource,
        isDOMEventSynthesized,
        isWidgetEventSynthesized,
        buttons);
    domutils.sendMouseEvent(
        "mouseup",
        left,
        top,
        button,
        clickCount,
        modifiers,
        false,
        pressure,
        inputSource,
        isDOMEventSynthesized,
        isWidgetEventSynthesized,
        buttons);
  }
};

/**
 * Call event.synthesizeMouse with coordinates at the centre of the
 * target.
 */
event.synthesizeMouseAtCenter = function(element, event, window) {
  let rect = element.getBoundingClientRect();
  event.synthesizeMouse(
      element,
      rect.width / 2,
      rect.height / 2,
      event,
      window);
};

/* eslint-disable */
function computeKeyCodeFromChar_(char, win = window) {
  if (char.length != 1) {
    return 0;
  }

  let KeyboardEvent = getKeyboardEvent_(win);

  if (char in VIRTUAL_KEYCODE_LOOKUP) {
    return KeyboardEvent["DOM_" + VIRTUAL_KEYCODE_LOOKUP[char]];
  }

  if (char >= "a" && char <= "z") {
    return KeyboardEvent.DOM_VK_A + char.charCodeAt(0) - "a".charCodeAt(0);
  }
  if (char >= "A" && char <= "Z") {
    return KeyboardEvent.DOM_VK_A + char.charCodeAt(0) - "A".charCodeAt(0);
  }
  if (char >= "0" && char <= "9") {
    return KeyboardEvent.DOM_VK_0 + char.charCodeAt(0) - "0".charCodeAt(0);
  }

  // returns US keyboard layout's keycode
  switch (char) {
    case "~":
    case "`":
      return KeyboardEvent.DOM_VK_BACK_QUOTE;

    case "!":
      return KeyboardEvent.DOM_VK_1;

    case "@":
      return KeyboardEvent.DOM_VK_2;

    case "#":
      return KeyboardEvent.DOM_VK_3;

    case "$":
      return KeyboardEvent.DOM_VK_4;

    case "%":
      return KeyboardEvent.DOM_VK_5;

    case "^":
      return KeyboardEvent.DOM_VK_6;

    case "&":
      return KeyboardEvent.DOM_VK_7;

    case "*":
      return KeyboardEvent.DOM_VK_8;

    case "(":
      return KeyboardEvent.DOM_VK_9;

    case ")":
      return KeyboardEvent.DOM_VK_0;

    case "-":
    case "_":
      return KeyboardEvent.DOM_VK_SUBTRACT;

    case "+":
    case "=":
      return KeyboardEvent.DOM_VK_EQUALS;

    case "{":
    case "[":
      return KeyboardEvent.DOM_VK_OPEN_BRACKET;

    case "}":
    case "]":
      return KeyboardEvent.DOM_VK_CLOSE_BRACKET;

    case "|":
    case "\\":
      return KeyboardEvent.DOM_VK_BACK_SLASH;

    case ":":
    case ";":
      return KeyboardEvent.DOM_VK_SEMICOLON;

    case "'":
    case "\"":
      return KeyboardEvent.DOM_VK_QUOTE;

    case "<":
    case ",":
      return KeyboardEvent.DOM_VK_COMMA;

    case ">":
    case ".":
      return KeyboardEvent.DOM_VK_PERIOD;

    case "?":
    case "/":
      return KeyboardEvent.DOM_VK_SLASH;

    case "\n":
      return KeyboardEvent.DOM_VK_RETURN;

    default:
      return 0;
  }
}
/* eslint-enable */

/**
 * Returns true if the given key should cause keypress event when widget
 * handles the native key event.  Otherwise, false.
 *
 * The key code should be one of consts of KeyboardEvent.DOM_VK_*,
 * or a key name begins with "VK_", or a character.
 */
event.isKeypressFiredKey = function(key) {
  let KeyboardEvent = getKeyboardEvent_();

  if (typeof key == "string") {
    if (key.indexOf("VK_") === 0) {
      key = KeyboardEvent["DOM_" + key];
      if (!key) {
        throw new TypeError("Unknown key: " + key);
      }

    // if key generates a character, it must cause a keypress event
    } else {
      return true;
    }
  }

  switch (key) {
    case KeyboardEvent.DOM_VK_SHIFT:
    case KeyboardEvent.DOM_VK_CONTROL:
    case KeyboardEvent.DOM_VK_ALT:
    case KeyboardEvent.DOM_VK_CAPS_LOCK:
    case KeyboardEvent.DOM_VK_NUM_LOCK:
    case KeyboardEvent.DOM_VK_SCROLL_LOCK:
    case KeyboardEvent.DOM_VK_META:
      return false;

    default:
      return true;
  }
};

/**
 * Synthesise a key event.
 *
 * It is targeted at whatever would be targeted by an actual keypress
 * by the user, typically the focused element.
 *
 * @param {string} key
 *     Key to synthesise.  Should either be a character or a key code
 *     starting with "VK_" such as VK_RETURN, or a normalized key value.
 * @param {Object.<string, ?>} event
 *     Object which may contain the properties shiftKey, ctrlKey, altKey,
 *     metaKey, accessKey, type.  If the type is specified (keydown or keyup),
 *     a key event of that type is fired.  Otherwise, a keydown, a keypress,
 *     and then a keyup event are fired in sequence.
 * @param {Window=} window
 *     Window object.  Defaults to the current window.
 *
 * @throws {TypeError}
 *     If unknown key.
 */
event.synthesizeKey = function(key, event, win = undefined) {
  let TIP = getTIP_(win);
  if (!TIP) {
    return;
  }
  let KeyboardEvent = getKeyboardEvent_(win);
  let modifiers = emulateToActivateModifiers_(TIP, event, win);
  let keyEventDict = createKeyboardEventDictionary_(key, event, win);
  let keyEvent = new KeyboardEvent("", keyEventDict.dictionary);
  let dispatchKeydown =
    !("type" in event) || event.type === "keydown" || !event.type;
  let dispatchKeyup =
    !("type" in event) || event.type === "keyup" || !event.type;

  try {
    if (dispatchKeydown) {
      TIP.keydown(keyEvent, keyEventDict.flags);
      if ("repeat" in event && event.repeat > 1) {
        keyEventDict.dictionary.repeat = true;
        let repeatedKeyEvent = new KeyboardEvent("", keyEventDict.dictionary);
        for (let i = 1; i < event.repeat; i++) {
          TIP.keydown(repeatedKeyEvent, keyEventDict.flags);
        }
      }
    }
    if (dispatchKeyup) {
      TIP.keyup(keyEvent, keyEventDict.flags);
    }
  } finally {
    emulateToInactivateModifiers_(TIP, modifiers, win);
  }
};

const TIPMap = new WeakMap();

function getTIP_(win, callback) {
  if (!win) {
    win = window;
  }
  let tip;
  if (TIPMap.has(win)) {
    tip = TIPMap.get(win);
  } else {
    tip = Cc["@mozilla.org/text-input-processor;1"]
        .createInstance(Ci.nsITextInputProcessor);
    TIPMap.set(win, tip);
  }
  if (!tip.beginInputTransactionForTests(win, callback)) {
    tip = null;
    TIPMap.delete(win);
  }
  return tip;
}

function getKeyboardEvent_(win = window) {
  if (typeof KeyboardEvent != "undefined") {
    try {
      // See if the object can be instantiated; sometimes this yields
      // 'TypeError: can't access dead object' or 'KeyboardEvent is not
      // a constructor'.
      new KeyboardEvent("", {});
      return KeyboardEvent;
    } catch (ex) {}
  }
  if (typeof content != "undefined" && ("KeyboardEvent" in content)) {
    return content.KeyboardEvent;
  }
  return win.KeyboardEvent;
}

function createKeyboardEventDictionary_(key, keyEvent, win = window) {
  let result = {dictionary: null, flags: 0};
  let keyCodeIsDefined = "keyCode" in keyEvent &&
      keyEvent.keyCode != undefined;
  let keyCode =
    (keyCodeIsDefined && keyEvent.keyCode >= 0 && keyEvent.keyCode <= 255) ?
      keyEvent.keyCode : 0;
  let keyName = "Unidentified";
  if (key.indexOf("KEY_") == 0) {
    keyName = key.substr("KEY_".length);
    result.flags |= Ci.nsITextInputProcessor.KEY_NON_PRINTABLE_KEY;
  } else if (key.indexOf("VK_") == 0) {
    keyCode = getKeyboardEvent_(win)["DOM_" + key];
    if (!keyCode) {
      throw "Unknown key: " + key;
    }
    keyName = guessKeyNameFromKeyCode_(keyCode, win);
    if (!isPrintable(keyCode, win)) {
      result.flags |= Ci.nsITextInputProcessor.KEY_NON_PRINTABLE_KEY;
    }
  } else if (key != "") {
    keyName = key;
    if (!keyCodeIsDefined) {
      keyCode = computeKeyCodeFromChar_(key.charAt(0), win);
    }
    if (!keyCode) {
      result.flags |= Ci.nsITextInputProcessor.KEY_KEEP_KEYCODE_ZERO;
    }
    // only force printable if "raw character" and event key match, like "a"
    if (!("key" in keyEvent && key != keyEvent.key)) {
      result.flags |= Ci.nsITextInputProcessor.KEY_FORCE_PRINTABLE_KEY;
    }
  }
  let locationIsDefined = "location" in keyEvent;
  if (locationIsDefined && keyEvent.location === 0) {
    result.flags |= Ci.nsITextInputProcessor.KEY_KEEP_KEY_LOCATION_STANDARD;
  }
  result.dictionary = {
    key: "key" in keyEvent ? keyEvent.key : keyName,
    code: "code" in keyEvent ? keyEvent.code : "",
    location: locationIsDefined ? keyEvent.location : 0,
    repeat: "repeat" in keyEvent ? keyEvent.repeat === true : false,
    keyCode,
  };
  return result;
}

function emulateToActivateModifiers_(TIP, keyEvent, win = window) {
  if (!keyEvent) {
    return null;
  }
  let KeyboardEvent = getKeyboardEvent_(win);

  let modifiers = {
    normal: [
      {key: "Alt",        attr: "altKey"},
      {key: "AltGraph",   attr: "altGraphKey"},
      {key: "Control",    attr: "ctrlKey"},
      {key: "Fn",         attr: "fnKey"},
      {key: "Meta",       attr: "metaKey"},
      {key: "OS",         attr: "osKey"},
      {key: "Shift",      attr: "shiftKey"},
      {key: "Symbol",     attr: "symbolKey"},
      {key: Services.appinfo.OS === "Darwin" ? "Meta" : "Control", attr: "accelKey"},
    ],
    lockable: [
      {key: "CapsLock",   attr: "capsLockKey"},
      {key: "FnLock",     attr: "fnLockKey"},
      {key: "NumLock",    attr: "numLockKey"},
      {key: "ScrollLock", attr: "scrollLockKey"},
      {key: "SymbolLock", attr: "symbolLockKey"},
    ],
  };

  for (let i = 0; i < modifiers.normal.length; i++) {
    if (!keyEvent[modifiers.normal[i].attr]) {
      continue;
    }
    if (TIP.getModifierState(modifiers.normal[i].key)) {
      continue; // already activated.
    }
    let event = new KeyboardEvent("", {key: modifiers.normal[i].key});
    TIP.keydown(event,
        TIP.KEY_NON_PRINTABLE_KEY | TIP.KEY_DONT_DISPATCH_MODIFIER_KEY_EVENT);
    modifiers.normal[i].activated = true;
  }

  for (let j = 0; j < modifiers.lockable.length; j++) {
    if (!keyEvent[modifiers.lockable[j].attr]) {
      continue;
    }
    if (TIP.getModifierState(modifiers.lockable[j].key)) {
      continue; // already activated.
    }
    let event = new KeyboardEvent("", {key: modifiers.lockable[j].key});
    TIP.keydown(event,
        TIP.KEY_NON_PRINTABLE_KEY | TIP.KEY_DONT_DISPATCH_MODIFIER_KEY_EVENT);
    TIP.keyup(event,
        TIP.KEY_NON_PRINTABLE_KEY | TIP.KEY_DONT_DISPATCH_MODIFIER_KEY_EVENT);
    modifiers.lockable[j].activated = true;
  }

  return modifiers;
}

function emulateToInactivateModifiers_(TIP, modifiers, win = window) {
  if (!modifiers) {
    return;
  }
  let KeyboardEvent = getKeyboardEvent_(win);
  for (let i = 0; i < modifiers.normal.length; i++) {
    if (!modifiers.normal[i].activated) {
      continue;
    }
    let event = new KeyboardEvent("", {key: modifiers.normal[i].key});
    TIP.keyup(event,
        TIP.KEY_NON_PRINTABLE_KEY | TIP.KEY_DONT_DISPATCH_MODIFIER_KEY_EVENT);
  }
  for (let j = 0; j < modifiers.lockable.length; j++) {
    if (!modifiers.lockable[j].activated) {
      continue;
    }
    if (!TIP.getModifierState(modifiers.lockable[j].key)) {
      continue; // who already inactivated this?
    }
    let event = new KeyboardEvent("", {key: modifiers.lockable[j].key});
    TIP.keydown(event,
        TIP.KEY_NON_PRINTABLE_KEY | TIP.KEY_DONT_DISPATCH_MODIFIER_KEY_EVENT);
    TIP.keyup(event,
        TIP.KEY_NON_PRINTABLE_KEY | TIP.KEY_DONT_DISPATCH_MODIFIER_KEY_EVENT);
  }
}

/* eslint-disable */
function guessKeyNameFromKeyCode_(aKeyCode, win = window) {
  let KeyboardEvent = getKeyboardEvent_(win);
  switch (aKeyCode) {
    case KeyboardEvent.DOM_VK_CANCEL:
      return "Cancel";
    case KeyboardEvent.DOM_VK_HELP:
      return "Help";
    case KeyboardEvent.DOM_VK_BACK_SPACE:
      return "Backspace";
    case KeyboardEvent.DOM_VK_TAB:
      return "Tab";
    case KeyboardEvent.DOM_VK_CLEAR:
      return "Clear";
    case KeyboardEvent.DOM_VK_RETURN:
      return "Enter";
    case KeyboardEvent.DOM_VK_SHIFT:
      return "Shift";
    case KeyboardEvent.DOM_VK_CONTROL:
      return "Control";
    case KeyboardEvent.DOM_VK_ALT:
      return "Alt";
    case KeyboardEvent.DOM_VK_PAUSE:
      return "Pause";
    case KeyboardEvent.DOM_VK_EISU:
      return "Eisu";
    case KeyboardEvent.DOM_VK_ESCAPE:
      return "Escape";
    case KeyboardEvent.DOM_VK_CONVERT:
      return "Convert";
    case KeyboardEvent.DOM_VK_NONCONVERT:
      return "NonConvert";
    case KeyboardEvent.DOM_VK_ACCEPT:
      return "Accept";
    case KeyboardEvent.DOM_VK_MODECHANGE:
      return "ModeChange";
    case KeyboardEvent.DOM_VK_PAGE_UP:
      return "PageUp";
    case KeyboardEvent.DOM_VK_PAGE_DOWN:
      return "PageDown";
    case KeyboardEvent.DOM_VK_END:
      return "End";
    case KeyboardEvent.DOM_VK_HOME:
      return "Home";
    case KeyboardEvent.DOM_VK_LEFT:
      return "ArrowLeft";
    case KeyboardEvent.DOM_VK_UP:
      return "ArrowUp";
    case KeyboardEvent.DOM_VK_RIGHT:
      return "ArrowRight";
    case KeyboardEvent.DOM_VK_DOWN:
      return "ArrowDown";
    case KeyboardEvent.DOM_VK_SELECT:
      return "Select";
    case KeyboardEvent.DOM_VK_PRINT:
      return "Print";
    case KeyboardEvent.DOM_VK_EXECUTE:
      return "Execute";
    case KeyboardEvent.DOM_VK_PRINTSCREEN:
      return "PrintScreen";
    case KeyboardEvent.DOM_VK_INSERT:
      return "Insert";
    case KeyboardEvent.DOM_VK_DELETE:
      return "Delete";
    case KeyboardEvent.DOM_VK_WIN:
      return "OS";
    case KeyboardEvent.DOM_VK_CONTEXT_MENU:
      return "ContextMenu";
    case KeyboardEvent.DOM_VK_SLEEP:
      return "Standby";
    case KeyboardEvent.DOM_VK_F1:
      return "F1";
    case KeyboardEvent.DOM_VK_F2:
      return "F2";
    case KeyboardEvent.DOM_VK_F3:
      return "F3";
    case KeyboardEvent.DOM_VK_F4:
      return "F4";
    case KeyboardEvent.DOM_VK_F5:
      return "F5";
    case KeyboardEvent.DOM_VK_F6:
      return "F6";
    case KeyboardEvent.DOM_VK_F7:
      return "F7";
    case KeyboardEvent.DOM_VK_F8:
      return "F8";
    case KeyboardEvent.DOM_VK_F9:
      return "F9";
    case KeyboardEvent.DOM_VK_F10:
      return "F10";
    case KeyboardEvent.DOM_VK_F11:
      return "F11";
    case KeyboardEvent.DOM_VK_F12:
      return "F12";
    case KeyboardEvent.DOM_VK_F13:
      return "F13";
    case KeyboardEvent.DOM_VK_F14:
      return "F14";
    case KeyboardEvent.DOM_VK_F15:
      return "F15";
    case KeyboardEvent.DOM_VK_F16:
      return "F16";
    case KeyboardEvent.DOM_VK_F17:
      return "F17";
    case KeyboardEvent.DOM_VK_F18:
      return "F18";
    case KeyboardEvent.DOM_VK_F19:
      return "F19";
    case KeyboardEvent.DOM_VK_F20:
      return "F20";
    case KeyboardEvent.DOM_VK_F21:
      return "F21";
    case KeyboardEvent.DOM_VK_F22:
      return "F22";
    case KeyboardEvent.DOM_VK_F23:
      return "F23";
    case KeyboardEvent.DOM_VK_F24:
      return "F24";
    case KeyboardEvent.DOM_VK_NUM_LOCK:
      return "NumLock";
    case KeyboardEvent.DOM_VK_SCROLL_LOCK:
      return "ScrollLock";
    case KeyboardEvent.DOM_VK_VOLUME_MUTE:
      return "AudioVolumeMute";
    case KeyboardEvent.DOM_VK_VOLUME_DOWN:
      return "AudioVolumeDown";
    case KeyboardEvent.DOM_VK_VOLUME_UP:
      return "AudioVolumeUp";
    case KeyboardEvent.DOM_VK_META:
      return "Meta";
    case KeyboardEvent.DOM_VK_ALTGR:
      return "AltGraph";
    case KeyboardEvent.DOM_VK_ATTN:
      return "Attn";
    case KeyboardEvent.DOM_VK_CRSEL:
      return "CrSel";
    case KeyboardEvent.DOM_VK_EXSEL:
      return "ExSel";
    case KeyboardEvent.DOM_VK_EREOF:
      return "EraseEof";
    case KeyboardEvent.DOM_VK_PLAY:
      return "Play";
    default:
      return "Unidentified";
  }
}
/* eslint-enable */

/**
 * Indicate that an event with an original target and type is expected
 * to be fired, or not expected to be fired.
 */
/* eslint-disable */
function expectEvent_(expectedTarget, expectedEvent, testName) {
  if (!expectedTarget || !expectedEvent) {
    return null;
  }

  seenEvent = false;

  let type;
  if (expectedEvent.charAt(0) == "!") {
    type = expectedEvent.substring(1);
  } else {
    type = expectedEvent;
  }

  let handler = ev => {
    let pass = (!seenEvent && ev.originalTarget == expectedTarget && ev.type == type);
    is(pass, true, `${testName} ${type} event target ${seenEvent ? "twice" : ""}`);
    seenEvent = true;
  };

  expectedTarget.addEventListener(type, handler);
  return handler;
}
/* eslint-enable */

/**
 * Check if the event was fired or not. The provided event handler will
 * be removed.
 */
function checkExpectedEvent_(
    expectedTarget, expectedEvent, eventHandler, testName) {

  if (eventHandler) {
    let expectEvent = (expectedEvent.charAt(0) != "!");
    let type = expectEvent;
    if (!type) {
      type = expectedEvent.substring(1);
    }
    expectedTarget.removeEventListener(type, eventHandler);

    let desc = `${type} event`;
    if (!expectEvent) {
      desc += " not";
    }
    is(seenEvent, expectEvent, `${testName} ${desc} fired`);
  }

  seenEvent = false;
}

/**
 * Similar to event.synthesizeMouse except that a test is performed to
 * see if an event is fired at the right target as a result.
 *
 * To test that an event is not fired, use an expected type preceded by
 * an exclamation mark, such as "!select". This might be used to test that
 * a click on a disabled element doesn't fire certain events for instance.
 *
 * @param {Element} target
 *     Synthesise the mouse event on this target.
 * @param {number} offsetX
 *     Horizontal offset from the target's bounding box.
 * @param {number} offsetY
 *     Vertical offset from the target's bounding box.
 * @param {Object.<string, ?>} ev
 *     Object which may contain the properties shiftKey, ctrlKey, altKey,
 *     metaKey, accessKey, type.
 * @param {Element} expectedTarget
 *     Expected originalTarget of the event.
 * @param {DOMEvent} expectedEvent
 *     Expected type of the event, such as "select".
 * @param {string} testName
 *     Test name when outputing results.
 * @param {Window=} window
 *     Window object.  Defaults to the current window.
 */
event.synthesizeMouseExpectEvent = function(
    target, offsetX, offsetY, ev, expectedTarget, expectedEvent,
    testName, window = undefined) {

  let eventHandler = expectEvent_(
      expectedTarget,
      expectedEvent,
      testName);
  event.synthesizeMouse(target, offsetX, offsetY, ev, window);
  checkExpectedEvent_(
      expectedTarget,
      expectedEvent,
      eventHandler,
      testName);
};

/**
 * Similar to synthesizeKey except that a test is performed to see if
 * an event is fired at the right target as a result.
 *
 * @param {string} key
 *     Key to synthesise.
 * @param {Object.<string, ?>} ev
 *     Object which may contain the properties shiftKey, ctrlKey, altKey,
 *     metaKey, accessKey, type.
 * @param {Element} expectedTarget
 *     Expected originalTarget of the event.
 * @param {DOMEvent} expectedEvent
 *     Expected type of the event, such as "select".
 * @param {string} testName
 *     Test name when outputing results
 * @param {Window=} window
 *     Window object.  Defaults to the current window.
 *
 * To test that an event is not fired, use an expected type preceded by an
 * exclamation mark, such as "!select".
 *
 * aWindow is optional, and defaults to the current window object.
 */
event.synthesizeKeyExpectEvent = function(
    key, ev, expectedTarget, expectedEvent, testName,
    window = undefined) {

  let eventHandler = expectEvent_(
      expectedTarget,
      expectedEvent,
      testName);
  event.synthesizeKey(key, ev, window);
  checkExpectedEvent_(
      expectedTarget,
      expectedEvent,
      eventHandler,
      testName);
};

/**
 * Synthesize a query selected text event.
 *
 * @param {Window=}
 *     Window object.  Defaults to the current window.
 *
 * @return {(nsIQueryContentEventResult|null)}
 *     Event's result, or null if it failed.
 */
event.synthesizeQuerySelectedText = function(window = undefined) {
  let domutils = getDOMWindowUtils(window);
  return domutils.sendQueryContentEvent(
      domutils.QUERY_SELECTED_TEXT, 0, 0, 0, 0);
};

/**
 * Synthesize a selection set event.
 *
 * @param {number} offset
 *     Character offset.  0 means the first character in the selection
 *     root.
 * @param {number} length
 *     Length of the text.  If the length is too long, the extra length
 *     is ignored.
 * @param {boolean} reverse
 *     If true, the selection is from |aOffset + aLength| to |aOffset|.
 *     Otherwise, from |aOffset| to |aOffset + aLength|.
 * @param {Window=} window
 *     Window object.  Defaults to the current window.
 *
 * @return         True, if succeeded.  Otherwise false.
 */
event.synthesizeSelectionSet = function(
    offset, length, reverse, window = undefined) {
  let domutils = getDOMWindowUtils(window);
  return domutils.sendSelectionSetEvent(offset, length, reverse);
};

const KEYCODES_LOOKUP = {
  "VK_SHIFT": "shiftKey",
  "VK_CONTROL": "ctrlKey",
  "VK_ALT": "altKey",
  "VK_META": "metaKey",
};

const VIRTUAL_KEYCODE_LOOKUP = {
  "\uE001": "VK_CANCEL",
  "\uE002": "VK_HELP",
  "\uE003": "VK_BACK_SPACE",
  "\uE004": "VK_TAB",
  "\uE005": "VK_CLEAR",
  "\uE006": "VK_RETURN",
  "\uE007": "VK_RETURN",
  "\uE008": "VK_SHIFT",
  "\uE009": "VK_CONTROL",
  "\uE00A": "VK_ALT",
  "\uE03D": "VK_META",
  "\uE00B": "VK_PAUSE",
  "\uE00C": "VK_ESCAPE",
  "\uE00D": "VK_SPACE",  // printable
  "\uE00E": "VK_PAGE_UP",
  "\uE00F": "VK_PAGE_DOWN",
  "\uE010": "VK_END",
  "\uE011": "VK_HOME",
  "\uE012": "VK_LEFT",
  "\uE013": "VK_UP",
  "\uE014": "VK_RIGHT",
  "\uE015": "VK_DOWN",
  "\uE016": "VK_INSERT",
  "\uE017": "VK_DELETE",
  "\uE018": "VK_SEMICOLON",
  "\uE019": "VK_EQUALS",
  "\uE01A": "VK_NUMPAD0",
  "\uE01B": "VK_NUMPAD1",
  "\uE01C": "VK_NUMPAD2",
  "\uE01D": "VK_NUMPAD3",
  "\uE01E": "VK_NUMPAD4",
  "\uE01F": "VK_NUMPAD5",
  "\uE020": "VK_NUMPAD6",
  "\uE021": "VK_NUMPAD7",
  "\uE022": "VK_NUMPAD8",
  "\uE023": "VK_NUMPAD9",
  "\uE024": "VK_MULTIPLY",
  "\uE025": "VK_ADD",
  "\uE026": "VK_SEPARATOR",
  "\uE027": "VK_SUBTRACT",
  "\uE028": "VK_DECIMAL",
  "\uE029": "VK_DIVIDE",
  "\uE031": "VK_F1",
  "\uE032": "VK_F2",
  "\uE033": "VK_F3",
  "\uE034": "VK_F4",
  "\uE035": "VK_F5",
  "\uE036": "VK_F6",
  "\uE037": "VK_F7",
  "\uE038": "VK_F8",
  "\uE039": "VK_F9",
  "\uE03A": "VK_F10",
  "\uE03B": "VK_F11",
  "\uE03C": "VK_F12",
};

function getKeyCode(c) {
  if (c in VIRTUAL_KEYCODE_LOOKUP) {
    return VIRTUAL_KEYCODE_LOOKUP[c];
  }
  return c;
}

function isPrintable(c, win = window) {
  let KeyboardEvent = getKeyboardEvent_(win);
  let NON_PRINT_KEYS = [
    KeyboardEvent.DOM_VK_CANCEL,
    KeyboardEvent.DOM_VK_HELP,
    KeyboardEvent.DOM_VK_BACK_SPACE,
    KeyboardEvent.DOM_VK_TAB,
    KeyboardEvent.DOM_VK_CLEAR,
    KeyboardEvent.DOM_VK_SHIFT,
    KeyboardEvent.DOM_VK_CONTROL,
    KeyboardEvent.DOM_VK_ALT,
    KeyboardEvent.DOM_VK_PAUSE,
    KeyboardEvent.DOM_VK_EISU,
    KeyboardEvent.DOM_VK_ESCAPE,
    KeyboardEvent.DOM_VK_CONVERT,
    KeyboardEvent.DOM_VK_NONCONVERT,
    KeyboardEvent.DOM_VK_ACCEPT,
    KeyboardEvent.DOM_VK_MODECHANGE,
    KeyboardEvent.DOM_VK_PAGE_UP,
    KeyboardEvent.DOM_VK_PAGE_DOWN,
    KeyboardEvent.DOM_VK_END,
    KeyboardEvent.DOM_VK_HOME,
    KeyboardEvent.DOM_VK_LEFT,
    KeyboardEvent.DOM_VK_UP,
    KeyboardEvent.DOM_VK_RIGHT,
    KeyboardEvent.DOM_VK_DOWN,
    KeyboardEvent.DOM_VK_SELECT,
    KeyboardEvent.DOM_VK_PRINT,
    KeyboardEvent.DOM_VK_EXECUTE,
    KeyboardEvent.DOM_VK_PRINTSCREEN,
    KeyboardEvent.DOM_VK_INSERT,
    KeyboardEvent.DOM_VK_DELETE,
    KeyboardEvent.DOM_VK_WIN,
    KeyboardEvent.DOM_VK_CONTEXT_MENU,
    KeyboardEvent.DOM_VK_SLEEP,
    KeyboardEvent.DOM_VK_F1,
    KeyboardEvent.DOM_VK_F2,
    KeyboardEvent.DOM_VK_F3,
    KeyboardEvent.DOM_VK_F4,
    KeyboardEvent.DOM_VK_F5,
    KeyboardEvent.DOM_VK_F6,
    KeyboardEvent.DOM_VK_F7,
    KeyboardEvent.DOM_VK_F8,
    KeyboardEvent.DOM_VK_F9,
    KeyboardEvent.DOM_VK_F10,
    KeyboardEvent.DOM_VK_F11,
    KeyboardEvent.DOM_VK_F12,
    KeyboardEvent.DOM_VK_F13,
    KeyboardEvent.DOM_VK_F14,
    KeyboardEvent.DOM_VK_F15,
    KeyboardEvent.DOM_VK_F16,
    KeyboardEvent.DOM_VK_F17,
    KeyboardEvent.DOM_VK_F18,
    KeyboardEvent.DOM_VK_F19,
    KeyboardEvent.DOM_VK_F20,
    KeyboardEvent.DOM_VK_F21,
    KeyboardEvent.DOM_VK_F22,
    KeyboardEvent.DOM_VK_F23,
    KeyboardEvent.DOM_VK_F24,
    KeyboardEvent.DOM_VK_NUM_LOCK,
    KeyboardEvent.DOM_VK_SCROLL_LOCK,
    KeyboardEvent.DOM_VK_VOLUME_MUTE,
    KeyboardEvent.DOM_VK_VOLUME_DOWN,
    KeyboardEvent.DOM_VK_VOLUME_UP,
    KeyboardEvent.DOM_VK_META,
    KeyboardEvent.DOM_VK_ALTGR,
    KeyboardEvent.DOM_VK_ATTN,
    KeyboardEvent.DOM_VK_CRSEL,
    KeyboardEvent.DOM_VK_EXSEL,
    KeyboardEvent.DOM_VK_EREOF,
    KeyboardEvent.DOM_VK_PLAY,
    KeyboardEvent.DOM_VK_RETURN,
  ];
  return !(NON_PRINT_KEYS.includes(c));
}

event.sendKeyDown = function(keyToSend, modifiers, document) {
  modifiers.type = "keydown";
  event.sendSingleKey(keyToSend, modifiers, document);
  // TODO: This doesn't do anything since |synthesizeKeyEvent| ignores
  // explicit keypress request, and instead figures out itself when to
  // send keypress.
  if (!["VK_SHIFT", "VK_CONTROL", "VK_ALT", "VK_META"]
      .includes(getKeyCode(keyToSend))) {
    modifiers.type = "keypress";
    event.sendSingleKey(keyToSend, modifiers, document);
  }
  delete modifiers.type;
};

event.sendKeyUp = function(keyToSend, modifiers, window = undefined) {
  modifiers.type = "keyup";
  event.sendSingleKey(keyToSend, modifiers, window);
  delete modifiers.type;
};

/**
 * Synthesize a key event for a single key.
 *
 * @param {string} keyToSend
 *     Code point or normalized key value
 * @param {Object.<string, boolean>} modifiers
 *     Object with properties used in KeyboardEvent (shiftkey, repeat, ...)
 *     as well as, the event |type| such as keydown. All properties
 *     are optional.
 * @param {Window=} window
 *     Window object.  If |window| is undefined, the event is synthesized
 *     in current window.
 */
event.sendSingleKey = function(keyToSend, modifiers, window = undefined) {
  let keyName = getKeyCode(keyToSend);
  if (keyName in KEYCODES_LOOKUP) {
    // We assume that if |keyToSend| is a raw code point (like "\uE009")
    // then |modifiers| does not already have correct value for corresponding
    // |modName| attribute (like ctrlKey), so that value needs to be flipped.
    let modName = KEYCODES_LOOKUP[keyName];
    modifiers[modName] = !modifiers[modName];
  } else if (modifiers.shiftKey && keyName != "Shift") {
    keyName = keyName.toUpperCase();
  }
  event.synthesizeKey(keyName, modifiers, window);
};

/**
 * @param {string} keyString
 * @param {Element} element
 * @param {Window=} window
 */
event.sendKeysToElement = function(keyString, el, window = undefined) {
  // make Object.<modifier, false> map
  let modifiers = Object.create(event.Modifiers);
  for (let modifier in event.Modifiers) {
    modifiers[modifier] = false;
  }

  for (let i = 0; i < keyString.length; i++) {
    let c = keyString.charAt(i);
    event.sendSingleKey(c, modifiers, window);
  }
};

event.sendEvent = function(eventType, el, modifiers = {}, opts = {}) {
  opts.canBubble = opts.canBubble || true;

  let doc = el.ownerDocument || el.document;
  let ev = doc.createEvent("Event");

  ev.shiftKey = modifiers.shift;
  ev.metaKey = modifiers.meta;
  ev.altKey = modifiers.alt;
  ev.ctrlKey = modifiers.ctrl;

  ev.initEvent(eventType, opts.canBubble, true);
  el.dispatchEvent(ev);
};

event.mouseover = function(el, modifiers = {}, opts = {}) {
  return event.sendEvent("mouseover", el, modifiers, opts);
};

event.mousemove = function(el, modifiers = {}, opts = {}) {
  return event.sendEvent("mousemove", el, modifiers, opts);
};

event.mousedown = function(el, modifiers = {}, opts = {}) {
  return event.sendEvent("mousedown", el, modifiers, opts);
};

event.mouseup = function(el, modifiers = {}, opts = {}) {
  return event.sendEvent("mouseup", el, modifiers, opts);
};

event.click = function(el, modifiers = {}, opts = {}) {
  return event.sendEvent("click", el, modifiers, opts);
};

event.change = function(el, modifiers = {}, opts = {}) {
  return event.sendEvent("change", el, modifiers, opts);
};

event.input = function(el, modifiers = {}, opts = {}) {
  return event.sendEvent("input", el, modifiers, opts);
};
