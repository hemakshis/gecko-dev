/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const actionTypes = {
  ADD_REQUEST: "ADD_REQUEST",
  ADD_TIMING_MARKER: "ADD_TIMING_MARKER",
  BATCH_ACTIONS: "BATCH_ACTIONS",
  BATCH_ENABLE: "BATCH_ENABLE",
  CLEAR_REQUESTS: "CLEAR_REQUESTS",
  CLEAR_TIMING_MARKERS: "CLEAR_TIMING_MARKERS",
  CLONE_SELECTED_REQUEST: "CLONE_SELECTED_REQUEST",
  ENABLE_REQUEST_FILTER_TYPE_ONLY: "ENABLE_REQUEST_FILTER_TYPE_ONLY",
  OPEN_NETWORK_DETAILS: "OPEN_NETWORK_DETAILS",
  RESIZE_NETWORK_DETAILS: "RESIZE_NETWORK_DETAILS",
  ENABLE_PERSISTENT_LOGS: "ENABLE_PERSISTENT_LOGS",
  DISABLE_BROWSER_CACHE: "DISABLE_BROWSER_CACHE",
  OPEN_STATISTICS: "OPEN_STATISTICS",
  REMOVE_SELECTED_CUSTOM_REQUEST: "REMOVE_SELECTED_CUSTOM_REQUEST",
  RESET_COLUMNS: "RESET_COLUMNS",
  SELECT_REQUEST: "SELECT_REQUEST",
  SELECT_DETAILS_PANEL_TAB: "SELECT_DETAILS_PANEL_TAB",
  SEND_CUSTOM_REQUEST: "SEND_CUSTOM_REQUEST",
  SET_REQUEST_FILTER_TEXT: "SET_REQUEST_FILTER_TEXT",
  SORT_BY: "SORT_BY",
  TOGGLE_COLUMN: "TOGGLE_COLUMN",
  TOGGLE_RECORDING: "TOGGLE_RECORDING",
  TOGGLE_REQUEST_FILTER_TYPE: "TOGGLE_REQUEST_FILTER_TYPE",
  UPDATE_REQUEST: "UPDATE_REQUEST",
  WATERFALL_RESIZE: "WATERFALL_RESIZE",
};

// Descriptions for what this frontend is currently doing.
const ACTIVITY_TYPE = {
  // Standing by and handling requests normally.
  NONE: 0,

  // Forcing the target to reload with cache enabled or disabled.
  RELOAD: {
    WITH_CACHE_ENABLED: 1,
    WITH_CACHE_DISABLED: 2,
    WITH_CACHE_DEFAULT: 3
  },

  // Enabling or disabling the cache without triggering a reload.
  ENABLE_CACHE: 3,
  DISABLE_CACHE: 4
};

// The panel's window global is an EventEmitter firing the following events:
const EVENTS = {
  // When a network or timeline event is received.
  // See https://developer.mozilla.org/docs/Tools/Web_Console/remoting for
  // more information about what each packet is supposed to deliver.
  NETWORK_EVENT: "NetMonitor:NetworkEvent",
  NETWORK_EVENT_UPDATED: "NetMonitor:NetworkEventUpdated",
  TIMELINE_EVENT: "NetMonitor:TimelineEvent",

  // When a network event is added to the view
  REQUEST_ADDED: "NetMonitor:RequestAdded",

  // When request headers begin and finish receiving.
  UPDATING_REQUEST_HEADERS: "NetMonitor:NetworkEventUpdating:RequestHeaders",
  RECEIVED_REQUEST_HEADERS: "NetMonitor:NetworkEventUpdated:RequestHeaders",

  // When request cookies begin and finish receiving.
  UPDATING_REQUEST_COOKIES: "NetMonitor:NetworkEventUpdating:RequestCookies",
  RECEIVED_REQUEST_COOKIES: "NetMonitor:NetworkEventUpdated:RequestCookies",

  // When request post data begins and finishes receiving.
  UPDATING_REQUEST_POST_DATA: "NetMonitor:NetworkEventUpdating:RequestPostData",
  RECEIVED_REQUEST_POST_DATA: "NetMonitor:NetworkEventUpdated:RequestPostData",

  // When security information begins and finishes receiving.
  UPDATING_SECURITY_INFO: "NetMonitor:NetworkEventUpdating:SecurityInfo",
  RECEIVED_SECURITY_INFO: "NetMonitor:NetworkEventUpdated:SecurityInfo",

  // When response headers begin and finish receiving.
  UPDATING_RESPONSE_HEADERS: "NetMonitor:NetworkEventUpdating:ResponseHeaders",
  RECEIVED_RESPONSE_HEADERS: "NetMonitor:NetworkEventUpdated:ResponseHeaders",

  // When response cookies begin and finish receiving.
  UPDATING_RESPONSE_COOKIES: "NetMonitor:NetworkEventUpdating:ResponseCookies",
  RECEIVED_RESPONSE_COOKIES: "NetMonitor:NetworkEventUpdated:ResponseCookies",

  // When event timings begin and finish receiving.
  UPDATING_EVENT_TIMINGS: "NetMonitor:NetworkEventUpdating:EventTimings",
  RECEIVED_EVENT_TIMINGS: "NetMonitor:NetworkEventUpdated:EventTimings",

  // When response content begins, updates and finishes receiving.
  STARTED_RECEIVING_RESPONSE: "NetMonitor:NetworkEventUpdating:ResponseStart",
  UPDATING_RESPONSE_CONTENT: "NetMonitor:NetworkEventUpdating:ResponseContent",
  RECEIVED_RESPONSE_CONTENT: "NetMonitor:NetworkEventUpdated:ResponseContent",

  // When stack-trace finishes receiving.
  RECEIVED_EVENT_STACKTRACE: "NetMonitor:NetworkEventUpdated:StackTrace",

  UPDATING_RESPONSE_CACHE: "NetMonitor:NetworkEventUpdating:ResponseCache",
  RECEIVED_RESPONSE_CACHE: "NetMonitor:NetworkEventUpdated:ResponseCache",

  // Fired once the connection is established
  CONNECTED: "connected",

  // When request payload (HTTP details data) are fetched from the backend.
  PAYLOAD_READY: "NetMonitor:PayloadReady",

  // When throttling is set on the backend.
  THROTTLING_CHANGED: "NetMonitor:ThrottlingChanged",
};

const UPDATE_PROPS = [
  "method",
  "url",
  "remotePort",
  "remoteAddress",
  "status",
  "statusText",
  "httpVersion",
  "securityState",
  "securityInfo",
  "securityInfoAvailable",
  "mimeType",
  "contentSize",
  "transferredSize",
  "totalTime",
  "eventTimings",
  "eventTimingsAvailable",
  "headersSize",
  "customQueryValue",
  "requestHeaders",
  "requestHeadersAvailable",
  "requestHeadersFromUploadStream",
  "requestCookies",
  "requestCookiesAvailable",
  "requestPostData",
  "requestPostDataAvailable",
  "responseHeaders",
  "responseHeadersAvailable",
  "responseCookies",
  "responseCookiesAvailable",
  "responseContent",
  "responseContentAvailable",
  "responseCache",
  "responseCacheAvailable",
  "formDataSections",
  "stacktrace",
  "isTrackingResource",
];

const PANELS = {
  COOKIES: "cookies",
  HEADERS: "headers",
  PARAMS: "params",
  RESPONSE: "response",
  CACHE: "cache",
  SECURITY: "security",
  STACK_TRACE: "stack-trace",
  TIMINGS: "timings",
};

const RESPONSE_HEADERS = [
  "Cache-Control",
  "Connection",
  "Content-Encoding",
  "Content-Length",
  "ETag",
  "Keep-Alive",
  "Last-Modified",
  "Server",
  "Vary"
];

const HEADERS = [
  {
    name: "status",
    label: "status3",
    canFilter: true,
    filterKey: "status-code"
  },
  {
    name: "method",
    canFilter: true,
  },
  {
    name: "file",
    canFilter: false,
  },
  {
    name: "protocol",
    canFilter: true,
  },
  {
    name: "scheme",
    canFilter: true,
  },
  {
    name: "domain",
    canFilter: true,
  },
  {
    name: "remoteip",
    canFilter: true,
    filterKey: "remote-ip",
  },
  {
    name: "cause",
    canFilter: true,
  },
  {
    name: "type",
    canFilter: false,
  },
  {
    name: "cookies",
    canFilter: false,
  },
  {
    name: "setCookies",
    boxName: "set-cookies",
    canFilter: false,
  },
  {
    name: "transferred",
    canFilter: true,
  },
  {
    name: "contentSize",
    boxName: "size",
    filterKey: "size",
    canFilter: true,
  },
  {
    name: "startTime",
    boxName: "start-time",
    canFilter: false,
    subMenu: "timings",
  },
  {
    name: "endTime",
    boxName: "end-time",
    canFilter: false,
    subMenu: "timings",
  },
  {
    name: "responseTime",
    boxName: "response-time",
    canFilter: false,
    subMenu: "timings",
  },
  {
    name: "duration",
    canFilter: false,
    subMenu: "timings",
  },
  {
    name: "latency",
    canFilter: false,
    subMenu: "timings",
  },
  ...RESPONSE_HEADERS
    .map(header => ({
      name: header,
      boxName: "response-header",
      canFilter: false,
      subMenu: "responseHeaders",
      noLocalization: true
    })),
  {
    name: "waterfall",
    canFilter: false,
  }
];

const HEADER_FILTERS = HEADERS
  .filter(h => h.canFilter)
  .map(h => h.filterKey || h.name);

const FILTER_FLAGS = [
  ...HEADER_FILTERS,
  "set-cookie-domain",
  "set-cookie-name",
  "set-cookie-value",
  "mime-type",
  "larger-than",
  "transferred-larger-than",
  "is",
  "has-response-header",
  "regexp",
];

const FILTER_TAGS = [
  "html",
  "css",
  "js",
  "xhr",
  "fonts",
  "images",
  "media",
  "ws",
  "other",
];

const REQUESTS_WATERFALL = {
  BACKGROUND_TICKS_MULTIPLE: 5, // ms
  BACKGROUND_TICKS_SCALES: 3,
  BACKGROUND_TICKS_SPACING_MIN: 10, // px
  BACKGROUND_TICKS_COLOR_RGB: [128, 136, 144],
  // 8-bit value of the alpha component of the tick color
  BACKGROUND_TICKS_OPACITY_MIN: 32,
  BACKGROUND_TICKS_OPACITY_ADD: 32,
  // Colors for timing markers (theme colors, see variables.css)
  DOMCONTENTLOADED_TICKS_COLOR: "highlight-blue",
  LOAD_TICKS_COLOR: "highlight-red",
  // Opacity for the timing markers
  TICKS_COLOR_OPACITY: 192,
  HEADER_TICKS_MULTIPLE: 5, // ms
  HEADER_TICKS_SPACING_MIN: 60, // px
  // Reserve extra space for rendering waterfall time label
  LABEL_WIDTH: 50, // px
};

const TIMING_KEYS = [
  "blocked",
  "dns",
  "connect",
  "ssl",
  "send",
  "wait",
  "receive",
];

const general = {
  ACTIVITY_TYPE,
  EVENTS,
  FILTER_SEARCH_DELAY: 200,
  UPDATE_PROPS,
  HEADERS,
  RESPONSE_HEADERS,
  FILTER_FLAGS,
  FILTER_TAGS,
  REQUESTS_WATERFALL,
  PANELS,
  TIMING_KEYS,
};

// flatten constants
module.exports = Object.assign({}, general, actionTypes);
