/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {
  DEBUG_TARGETS,
  REQUEST_EXTENSIONS_SUCCESS,
} = require("../constants");

/**
 * This middleware converts extensions object that get from DebuggerClient.listAddons()
 * to data which is used in DebugTargetItem.
 */
const extensionComponentDataMiddleware = store => next => action => {
  switch (action.type) {
    case REQUEST_EXTENSIONS_SUCCESS: {
      action.installedExtensions = toComponentData(action.installedExtensions);
      action.temporaryExtensions = toComponentData(action.temporaryExtensions);
      break;
    }
  }

  return next(action);
};

function getFilePath(extension) {
  // Only show file system paths, and only for temporarily installed add-ons.
  if (!extension.temporarilyInstalled ||
      !extension.url ||
      !extension.url.startsWith("file://")) {
    return null;
  }

  // Strip a leading slash from Windows drive letter URIs.
  // file:///home/foo ~> /home/foo
  // file:///C:/foo ~> C:/foo
  const windowsRegex = /^file:\/\/\/([a-zA-Z]:\/.*)/;

  if (windowsRegex.test(extension.url)) {
    return windowsRegex.exec(extension.url)[1];
  }

  return extension.url.slice("file://".length);
}

function toComponentData(extensions) {
  return extensions.map(extension => {
    const type = DEBUG_TARGETS.EXTENSION;
    const { actor, iconURL, id, manifestURL, name } = extension;
    const icon = iconURL || "chrome://mozapps/skin/extensions/extensionGeneric.svg";
    const location = getFilePath(extension);
    const uuid = manifestURL ? /moz-extension:\/\/([^/]*)/.exec(manifestURL)[1] : null;
    return {
      name,
      icon,
      id,
      type,
      details: {
        actor,
        location,
        manifestURL,
        uuid,
      },
    };
  });
}

module.exports = extensionComponentDataMiddleware;
