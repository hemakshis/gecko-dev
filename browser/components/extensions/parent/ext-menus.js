/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
"use strict";

ChromeUtils.import("resource://gre/modules/Services.jsm");

var {
  DefaultMap,
  ExtensionError,
} = ExtensionUtils;

ChromeUtils.import("resource://gre/modules/ExtensionParent.jsm");

var {
  IconDetails,
} = ExtensionParent;

const ACTION_MENU_TOP_LEVEL_LIMIT = 6;

// Map[Extension -> Map[ID -> MenuItem]]
// Note: we want to enumerate all the menu items so
// this cannot be a weak map.
var gMenuMap = new Map();

// Map[Extension -> MenuItem]
var gRootItems = new Map();

// Map[Extension -> ID[]]
// Menu IDs that were eligible for being shown in the current menu.
var gShownMenuItems = new DefaultMap(() => []);

// Set of extensions that are listening to onShown.
var gOnShownSubscribers = new Set();

// If id is not specified for an item we use an integer.
var gNextMenuItemID = 0;

// Used to assign unique names to radio groups.
var gNextRadioGroupID = 0;

// The max length of a menu item's label.
var gMaxLabelLength = 64;

var gMenuBuilder = {
  // When a new menu is opened, this function is called and
  // we populate the |xulMenu| with all the items from extensions
  // to be displayed. We always clear all the items again when
  // popuphidden fires.
  build(contextData) {
    let xulMenu = contextData.menu;
    xulMenu.addEventListener("popuphidden", this);
    this.xulMenu = xulMenu;
    for (let [, root] of gRootItems) {
      let rootElement = this.createTopLevelElement(root, contextData);
      if (rootElement) {
        this.appendTopLevelElement(rootElement);
      }
    }
    this.afterBuildingMenu(contextData);
  },

  // Builds a context menu for browserAction and pageAction buttons.
  buildActionContextMenu(contextData) {
    const {menu} = contextData;

    const root = gRootItems.get(contextData.extension);
    if (!root) {
      return;
    }

    const children = this.buildChildren(root, contextData);
    const visible = children.slice(0, ACTION_MENU_TOP_LEVEL_LIMIT);

    this.xulMenu = menu;
    menu.addEventListener("popuphidden", this);

    if (visible.length) {
      const separator = menu.ownerDocument.createXULElement("menuseparator");
      menu.insertBefore(separator, menu.firstElementChild);
      this.itemsToCleanUp.add(separator);

      for (const child of visible) {
        this.itemsToCleanUp.add(child);
        menu.insertBefore(child, separator);
      }
    }
    this.afterBuildingMenu(contextData);
  },

  buildElementWithChildren(item, contextData) {
    const element = this.buildSingleElement(item, contextData);
    const children = this.buildChildren(item, contextData);
    if (children.length) {
      element.firstElementChild.append(...children);
    }
    return element;
  },

  buildChildren(item, contextData) {
    let groupName;
    let children = [];
    for (let child of item.children) {
      if (child.type == "radio" && !child.groupName) {
        if (!groupName) {
          groupName = `webext-radio-group-${gNextRadioGroupID++}`;
        }
        child.groupName = groupName;
      } else {
        groupName = null;
      }

      if (child.enabledForContext(contextData)) {
        children.push(this.buildElementWithChildren(child, contextData));
      }
    }
    return children;
  },

  createTopLevelElement(root, contextData) {
    let rootElement = this.buildElementWithChildren(root, contextData);
    if (!rootElement.firstElementChild || !rootElement.firstElementChild.children.length) {
      // If the root has no visible children, there is no reason to show
      // the root menu item itself either.
      return null;
    }
    rootElement.setAttribute("ext-type", "top-level-menu");
    rootElement = this.removeTopLevelMenuIfNeeded(rootElement);

    // Display the extension icon on the root element.
    if (root.extension.manifest.icons) {
      this.setMenuItemIcon(rootElement, root.extension, contextData, root.extension.manifest.icons);
    } else {
      // Undo changes from setMenuItemIcon:
      rootElement.removeAttribute("class");
      rootElement.removeAttribute("image");
    }
    return rootElement;
  },

  appendTopLevelElement(rootElement) {
    if (this.itemsToCleanUp.size === 0) {
      const separator = this.xulMenu.ownerDocument.createXULElement("menuseparator");
      this.itemsToCleanUp.add(separator);
      this.xulMenu.append(separator);
    }

    this.xulMenu.appendChild(rootElement);
    this.itemsToCleanUp.add(rootElement);
  },

  removeSeparatorIfNoTopLevelItems() {
    if (this.itemsToCleanUp.size === 1) {
      // Remove the separator if all extension menu items have disappeared.
      const separator = this.itemsToCleanUp.values().next().value;
      separator.remove();
      this.itemsToCleanUp.clear();
    }
  },

  removeTopLevelMenuIfNeeded(element) {
    // If there is only one visible top level element we don't need the
    // root menu element for the extension.
    let menuPopup = element.firstElementChild;
    if (menuPopup && menuPopup.children.length == 1) {
      let onlyChild = menuPopup.firstElementChild;

      // Keep single checkbox items in the submenu on Linux since
      // the extension icon overlaps the checkbox otherwise.
      if (AppConstants.platform === "linux" && onlyChild.getAttribute("type") === "checkbox") {
        return element;
      }

      onlyChild.remove();
      return onlyChild;
    }

    return element;
  },

  buildSingleElement(item, contextData) {
    let doc = contextData.menu.ownerDocument;
    let element;
    if (item.children.length > 0) {
      element = this.createMenuElement(doc, item);
    } else if (item.type == "separator") {
      element = doc.createXULElement("menuseparator");
    } else {
      element = doc.createXULElement("menuitem");
    }

    return this.customizeElement(element, item, contextData);
  },

  createMenuElement(doc, item) {
    let element = doc.createXULElement("menu");
    // Menu elements need to have a menupopup child for its menu items.
    let menupopup = doc.createXULElement("menupopup");
    element.appendChild(menupopup);
    return element;
  },

  customizeElement(element, item, contextData) {
    let label = item.title;
    if (label) {
      let accessKey;
      label = label.replace(/&([\S\s]|$)/g, (_, nextChar, i) => {
        if (nextChar === "&") {
          return "&";
        }
        if (accessKey === undefined) {
          if (nextChar === "%" && label.charAt(i + 2) === "s") {
            accessKey = "";
          } else {
            accessKey = nextChar;
          }
        }
        return nextChar;
      });
      element.setAttribute("accesskey", accessKey || "");

      if (contextData.isTextSelected && label.indexOf("%s") > -1) {
        let selection = contextData.selectionText.trim();
        // The rendering engine will truncate the title if it's longer than 64 characters.
        // But if it makes sense let's try truncate selection text only, to handle cases like
        // 'look up "%s" in MyDictionary' more elegantly.

        let codePointsToRemove = 0;

        let selectionArray = Array.from(selection);

        let completeLabelLength = label.length - 2 + selectionArray.length;
        if (completeLabelLength > gMaxLabelLength) {
          codePointsToRemove = completeLabelLength - gMaxLabelLength;
        }

        if (codePointsToRemove) {
          let ellipsis = "\u2026";
          try {
            ellipsis = Services.prefs.getComplexValue("intl.ellipsis",
                                                      Ci.nsIPrefLocalizedString).data;
          } catch (e) { }
          codePointsToRemove += 1;
          selection = selectionArray.slice(0, -codePointsToRemove).join("") + ellipsis;
        }

        label = label.replace(/%s/g, selection);
      }

      element.setAttribute("label", label);
    }

    element.setAttribute("id", item.elementId);

    if (item.icons) {
      this.setMenuItemIcon(element, item.extension, contextData, item.icons);
    }

    if (item.type == "checkbox") {
      element.setAttribute("type", "checkbox");
      if (item.checked) {
        element.setAttribute("checked", "true");
      }
    } else if (item.type == "radio") {
      element.setAttribute("type", "radio");
      element.setAttribute("name", item.groupName);
      if (item.checked) {
        element.setAttribute("checked", "true");
      }
    }

    if (!item.enabled) {
      element.setAttribute("disabled", "true");
    }

    element.addEventListener("command", event => { // eslint-disable-line mozilla/balanced-listeners
      if (event.target !== event.currentTarget) {
        return;
      }
      const wasChecked = item.checked;
      if (item.type == "checkbox") {
        item.checked = !item.checked;
      } else if (item.type == "radio") {
        // Deselect all radio items in the current radio group.
        for (let child of item.parent.children) {
          if (child.type == "radio" && child.groupName == item.groupName) {
            child.checked = false;
          }
        }
        // Select the clicked radio item.
        item.checked = true;
      }

      if (contextData.tab) {
        item.tabManager.addActiveTabPermission(contextData.tab);
      }

      let info = item.getClickInfo(contextData, wasChecked);

      const map = {shiftKey: "Shift", altKey: "Alt", metaKey: "Command", ctrlKey: "Ctrl"};
      info.modifiers = Object.keys(map).filter(key => event[key]).map(key => map[key]);
      if (event.ctrlKey && AppConstants.platform === "macosx") {
        info.modifiers.push("MacCtrl");
      }

      // Allow menus to open various actions supported in webext prior
      // to notifying onclicked.
      let actionFor = {
        _execute_page_action: global.pageActionFor,
        _execute_browser_action: global.browserActionFor,
        _execute_sidebar_action: global.sidebarActionFor,
      }[item.command];
      if (actionFor) {
        let win = event.target.ownerGlobal;
        actionFor(item.extension).triggerAction(win);
      }

      item.extension.emit("webext-menu-menuitem-click", info, contextData.tab);
    });

    // Don't publish the ID of the root because the root element is
    // auto-generated.
    if (item.parent) {
      gShownMenuItems.get(item.extension).push(item.id);
    }

    return element;
  },

  setMenuItemIcon(element, extension, contextData, icons) {
    let parentWindow = contextData.menu.ownerGlobal;

    let {icon} = IconDetails.getPreferredIcon(icons, extension,
                                              16 * parentWindow.devicePixelRatio);

    // The extension icons in the manifest are not pre-resolved, since
    // they're sometimes used by the add-on manager when the extension is
    // not enabled, and its URLs are not resolvable.
    let resolvedURL = extension.baseURI.resolve(icon);

    if (element.localName == "menu") {
      element.setAttribute("class", "menu-iconic");
    } else if (element.localName == "menuitem") {
      element.setAttribute("class", "menuitem-iconic");
    }

    element.setAttribute("image", resolvedURL);
  },

  rebuildMenu(extension) {
    let {contextData} = this;
    if (!contextData) {
      // This happens if the menu is not visible.
      return;
    }

    if (contextData.onBrowserAction || contextData.onPageAction) {
      if (contextData.extension.id !== extension.id) {
        // The extension that just called refresh() is not the owner of the
        // action whose context menu is showing, so it can't have any items in
        // the menu anyway and nothing will change.
        return;
      }
      // The action menu can only have items from one extension, so remove all
      // items (including the separator) and rebuild the action menu (if any).
      for (let item of this.itemsToCleanUp) {
        item.remove();
      }
      this.itemsToCleanUp.clear();
      this.buildActionContextMenu(contextData);
      return;
    }

    // First find the one and only top-level menu item for the extension.
    let elementIdPrefix = `${makeWidgetId(extension.id)}-menuitem-`;
    let oldRoot = null;
    for (let item = this.xulMenu.lastElementChild; item !== null; item = item.previousElementSibling) {
      if (item.id && item.id.startsWith(elementIdPrefix)) {
        oldRoot = item;
        this.itemsToCleanUp.delete(oldRoot);
        break;
      }
    }

    let root = gRootItems.get(extension);
    let newRoot = root && this.createTopLevelElement(root, contextData);
    if (newRoot) {
      this.itemsToCleanUp.add(newRoot);
      if (oldRoot) {
        oldRoot.replaceWith(newRoot);
      } else {
        this.appendTopLevelElement(newRoot);
      }
    } else if (oldRoot) {
      oldRoot.remove();
      this.removeSeparatorIfNoTopLevelItems();
    }
  },

  afterBuildingMenu(contextData) {
    if (this.contextData) {
      // rebuildMenu can trigger us again, but the logic below should run only
      // once per open menu.
      return;
    }

    function dispatchOnShownEvent(extension) {
      // Note: gShownMenuItems is a DefaultMap, so .get(extension) causes the
      // extension to be stored in the map even if there are currently no
      // shown menu items. This ensures that the onHidden event can be fired
      // when the menu is closed.
      let menuIds = gShownMenuItems.get(extension);
      extension.emit("webext-menu-shown", menuIds, contextData);
    }

    if (contextData.onBrowserAction || contextData.onPageAction) {
      dispatchOnShownEvent(contextData.extension);
    } else {
      gOnShownSubscribers.forEach(dispatchOnShownEvent);
    }

    this.contextData = contextData;
  },

  handleEvent(event) {
    if (this.xulMenu != event.target || event.type != "popuphidden") {
      return;
    }

    delete this.xulMenu;
    delete this.contextData;

    let target = event.target;
    target.removeEventListener("popuphidden", this);
    for (let item of this.itemsToCleanUp) {
      item.remove();
    }
    this.itemsToCleanUp.clear();
    for (let extension of gShownMenuItems.keys()) {
      extension.emit("webext-menu-hidden");
    }
    gShownMenuItems.clear();
  },

  itemsToCleanUp: new Set(),
};

// Called from pageAction or browserAction popup.
global.actionContextMenu = function(contextData) {
  contextData.tab = tabTracker.activeTab;
  contextData.pageUrl = contextData.tab.linkedBrowser.currentURI.spec;
  gMenuBuilder.buildActionContextMenu(contextData);
};

const contextsMap = {
  onAudio: "audio",
  onEditable: "editable",
  inFrame: "frame",
  onImage: "image",
  onLink: "link",
  onPassword: "password",
  isTextSelected: "selection",
  onVideo: "video",

  onBookmark: "bookmark",
  onBrowserAction: "browser_action",
  onPageAction: "page_action",
  onTab: "tab",
  inToolsMenu: "tools_menu",
};

const getMenuContexts = contextData => {
  let contexts = new Set();

  for (const [key, value] of Object.entries(contextsMap)) {
    if (contextData[key]) {
      contexts.add(value);
    }
  }

  if (contexts.size === 0) {
    contexts.add("page");
  }

  // New non-content contexts supported in Firefox are not part of "all".
  if (!contextData.onBookmark && !contextData.onTab && !contextData.inToolsMenu) {
    contexts.add("all");
  }

  return contexts;
};

function addMenuEventInfo(info, contextData, extension, includeSensitiveData) {
  if (contextData.onVideo) {
    info.mediaType = "video";
  } else if (contextData.onAudio) {
    info.mediaType = "audio";
  } else if (contextData.onImage) {
    info.mediaType = "image";
  }
  if (contextData.frameId !== undefined) {
    info.frameId = contextData.frameId;
  }
  if (contextData.onBookmark) {
    info.bookmarkId = contextData.bookmarkId;
  }
  info.editable = contextData.onEditable || false;
  if (includeSensitiveData) {
    // menus.getTargetElement requires the "menus" permission, so do not set
    // targetElementId for extensions with only the "contextMenus" permission.
    if (contextData.timeStamp && extension.hasPermission("menus")) {
      // Convert to integer, in case the DOMHighResTimeStamp has a fractional part.
      info.targetElementId = Math.floor(contextData.timeStamp);
    }
    if (contextData.onLink) {
      info.linkText = contextData.linkText;
      info.linkUrl = contextData.linkUrl;
    }
    if (contextData.onAudio || contextData.onImage || contextData.onVideo) {
      info.srcUrl = contextData.srcUrl;
    }
    if (!contextData.onBookmark) {
      info.pageUrl = contextData.pageUrl;
    }
    if (contextData.inFrame) {
      info.frameUrl = contextData.frameUrl;
    }
    if (contextData.isTextSelected) {
      info.selectionText = contextData.selectionText;
    }
  }
}

function MenuItem(extension, createProperties, isRoot = false) {
  this.extension = extension;
  this.children = [];
  this.parent = null;
  this.tabManager = extension.tabManager;

  this.setDefaults();
  this.setProps(createProperties);

  if (!this.hasOwnProperty("_id")) {
    this.id = gNextMenuItemID++;
  }
  // If the item is not the root and has no parent
  // it must be a child of the root.
  if (!isRoot && !this.parent) {
    this.root.addChild(this);
  }
}

MenuItem.prototype = {
  setProps(createProperties) {
    for (let propName in createProperties) {
      if (createProperties[propName] === null) {
        // Omitted optional argument.
        continue;
      }
      this[propName] = createProperties[propName];
    }

    if (createProperties.documentUrlPatterns != null) {
      this.documentUrlMatchPattern = new MatchPatternSet(this.documentUrlPatterns);
    }

    if (createProperties.targetUrlPatterns != null) {
      this.targetUrlMatchPattern = new MatchPatternSet(this.targetUrlPatterns, {restrictSchemes: false});
    }

    // If a child MenuItem does not specify any contexts, then it should
    // inherit the contexts specified from its parent.
    if (createProperties.parentId && !createProperties.contexts) {
      this.contexts = this.parent.contexts;
    }
  },

  setDefaults() {
    this.setProps({
      type: "normal",
      checked: false,
      contexts: ["all"],
      enabled: true,
      visible: true,
    });
  },

  set id(id) {
    if (this.hasOwnProperty("_id")) {
      throw new ExtensionError("ID of a MenuItem cannot be changed");
    }
    let isIdUsed = gMenuMap.get(this.extension).has(id);
    if (isIdUsed) {
      throw new ExtensionError(`ID already exists: ${id}`);
    }
    this._id = id;
  },

  get id() {
    return this._id;
  },

  get elementId() {
    let id = this.id;
    // If the ID is an integer, it is auto-generated and globally unique.
    // If the ID is a string, it is only unique within one extension and the
    // ID needs to be concatenated with the extension ID.
    if (typeof id !== "number") {
      // To avoid collisions with numeric IDs, add a prefix to string IDs.
      id = `_${id}`;
    }
    return `${makeWidgetId(this.extension.id)}-menuitem-${id}`;
  },

  ensureValidParentId(parentId) {
    if (parentId === undefined) {
      return;
    }
    let menuMap = gMenuMap.get(this.extension);
    if (!menuMap.has(parentId)) {
      throw new ExtensionError(`Could not find any MenuItem with id: ${parentId}`);
    }
    for (let item = menuMap.get(parentId); item; item = item.parent) {
      if (item === this) {
        throw new ExtensionError("MenuItem cannot be an ancestor (or self) of its new parent.");
      }
    }
  },

  set parentId(parentId) {
    this.ensureValidParentId(parentId);

    if (this.parent) {
      this.parent.detachChild(this);
    }

    if (parentId === undefined) {
      this.root.addChild(this);
    } else {
      let menuMap = gMenuMap.get(this.extension);
      menuMap.get(parentId).addChild(this);
    }
  },

  get parentId() {
    return this.parent ? this.parent.id : undefined;
  },

  addChild(child) {
    if (child.parent) {
      throw new Error("Child MenuItem already has a parent.");
    }
    this.children.push(child);
    child.parent = this;
  },

  detachChild(child) {
    let idx = this.children.indexOf(child);
    if (idx < 0) {
      throw new Error("Child MenuItem not found, it cannot be removed.");
    }
    this.children.splice(idx, 1);
    child.parent = null;
  },

  get root() {
    let extension = this.extension;
    if (!gRootItems.has(extension)) {
      let root = new MenuItem(extension,
                              {title: extension.name},
                              /* isRoot = */ true);
      gRootItems.set(extension, root);
    }

    return gRootItems.get(extension);
  },

  remove() {
    if (this.parent) {
      this.parent.detachChild(this);
    }
    let children = this.children.slice(0);
    for (let child of children) {
      child.remove();
    }

    let menuMap = gMenuMap.get(this.extension);
    menuMap.delete(this.id);
    if (this.root == this) {
      gRootItems.delete(this.extension);
    }
  },

  getClickInfo(contextData, wasChecked) {
    let info = {
      menuItemId: this.id,
    };
    if (this.parent) {
      info.parentMenuItemId = this.parentId;
    }

    addMenuEventInfo(info, contextData, this.extension, true);

    if ((this.type === "checkbox") || (this.type === "radio")) {
      info.checked = this.checked;
      info.wasChecked = wasChecked;
    }

    return info;
  },

  enabledForContext(contextData) {
    if (!this.visible) {
      return false;
    }
    let contexts = getMenuContexts(contextData);
    if (!this.contexts.some(n => contexts.has(n))) {
      return false;
    }

    if (contextData.onBookmark) {
      return this.extension.hasPermission("bookmarks");
    }

    let docPattern = this.documentUrlMatchPattern;
    let pageURI = Services.io.newURI(contextData[contextData.inFrame ? "frameUrl" : "pageUrl"]);
    if (docPattern && !docPattern.matches(pageURI)) {
      return false;
    }

    let targetPattern = this.targetUrlMatchPattern;
    if (targetPattern) {
      let targetUrls = [];
      if (contextData.onImage || contextData.onAudio || contextData.onVideo) {
        // TODO: double check if srcUrl is always set when we need it
        targetUrls.push(contextData.srcUrl);
      }
      if (contextData.onLink) {
        targetUrls.push(contextData.linkUrl);
      }
      if (!targetUrls.some(targetUrl => targetPattern.matches(Services.io.newURI(targetUrl)))) {
        return false;
      }
    }

    return true;
  },
};

// While any extensions are active, this Tracker registers to observe/listen
// for menu events from both Tools and context menus, both content and chrome.
const menuTracker = {
  menuIds: ["placesContext", "menu_ToolsPopup", "tabContextMenu"],

  register() {
    Services.obs.addObserver(this, "on-build-contextmenu");
    for (const window of windowTracker.browserWindows()) {
      this.onWindowOpen(window);
    }
    windowTracker.addOpenListener(this.onWindowOpen);
  },

  unregister() {
    Services.obs.removeObserver(this, "on-build-contextmenu");
    for (const window of windowTracker.browserWindows()) {
      for (const id of this.menuIds) {
        const menu = window.document.getElementById(id);
        menu.removeEventListener("popupshowing", this);
      }
    }
    windowTracker.removeOpenListener(this.onWindowOpen);
  },

  observe(subject, topic, data) {
    subject = subject.wrappedJSObject;
    gMenuBuilder.build(subject);
  },

  onWindowOpen(window) {
    for (const id of menuTracker.menuIds) {
      const menu = window.document.getElementById(id);
      menu.addEventListener("popupshowing", menuTracker);
    }
  },

  handleEvent(event) {
    const menu = event.target;
    if (menu.id === "placesContext") {
      const trigger = menu.triggerNode;
      if (!trigger._placesNode) {
        return;
      }

      gMenuBuilder.build({
        menu,
        bookmarkId: trigger._placesNode.bookmarkGuid,
        onBookmark: true,
      });
    }
    if (menu.id === "menu_ToolsPopup") {
      const tab = tabTracker.activeTab;
      const pageUrl = tab.linkedBrowser.currentURI.spec;
      gMenuBuilder.build({menu, tab, pageUrl, inToolsMenu: true});
    }
    if (menu.id === "tabContextMenu") {
      const trigger = menu.triggerNode;
      const tab = trigger.localName === "tab" ? trigger : tabTracker.activeTab;
      const pageUrl = tab.linkedBrowser.currentURI.spec;
      gMenuBuilder.build({menu, tab, pageUrl, onTab: true});
    }
  },
};

this.menusInternal = class extends ExtensionAPI {
  constructor(extension) {
    super(extension);

    if (!gMenuMap.size) {
      menuTracker.register();
    }
    gMenuMap.set(extension, new Map());
  }

  onShutdown(reason) {
    let {extension} = this;

    if (gMenuMap.has(extension)) {
      gMenuMap.delete(extension);
      gRootItems.delete(extension);
      gShownMenuItems.delete(extension);
      gOnShownSubscribers.delete(extension);
      if (!gMenuMap.size) {
        menuTracker.unregister();
      }
    }
  }

  getAPI(context) {
    let {extension} = context;

    const menus = {
      refresh() {
        gMenuBuilder.rebuildMenu(extension);
      },

      onShown: new EventManager({
        context,
        name: "menus.onShown",
        register: fire => {
          let listener = (event, menuIds, contextData) => {
            let info = {
              menuIds,
              contexts: Array.from(getMenuContexts(contextData)),
            };

            let nativeTab = contextData.tab;

            // The menus.onShown event is fired before the user has consciously
            // interacted with an extension, so we require permissions before
            // exposing sensitive contextual data.
            let contextUrl = contextData.inFrame ? contextData.frameUrl : contextData.pageUrl;
            let includeSensitiveData =
              (nativeTab && extension.tabManager.hasActiveTabPermission(nativeTab)) ||
              (contextUrl && extension.whiteListedHosts.matches(contextUrl));

            addMenuEventInfo(info, contextData, extension, includeSensitiveData);

            let tab = nativeTab && extension.tabManager.convert(nativeTab);
            fire.sync(info, tab);
          };
          gOnShownSubscribers.add(extension);
          extension.on("webext-menu-shown", listener);
          return () => {
            gOnShownSubscribers.delete(extension);
            extension.off("webext-menu-shown", listener);
          };
        },
      }).api(),
      onHidden: new EventManager({
        context,
        name: "menus.onHidden",
        register: fire => {
          let listener = () => {
            fire.sync();
          };
          extension.on("webext-menu-hidden", listener);
          return () => {
            extension.off("webext-menu-hidden", listener);
          };
        },
      }).api(),
    };

    return {
      contextMenus: menus,
      menus,
      menusInternal: {
        create: function(createProperties) {
          // Note that the id is required by the schema. If the addon did not set
          // it, the implementation of menus.create in the child should
          // have added it.
          let menuItem = new MenuItem(extension, createProperties);
          gMenuMap.get(extension).set(menuItem.id, menuItem);
        },

        update: function(id, updateProperties) {
          let menuItem = gMenuMap.get(extension).get(id);
          if (menuItem) {
            menuItem.setProps(updateProperties);
          }
        },

        remove: function(id) {
          let menuItem = gMenuMap.get(extension).get(id);
          if (menuItem) {
            menuItem.remove();
          }
        },

        removeAll: function() {
          let root = gRootItems.get(extension);
          if (root) {
            root.remove();
          }
        },

        onClicked: new EventManager({
          context,
          name: "menusInternal.onClicked",
          register: fire => {
            let listener = (event, info, nativeTab) => {
              let {linkedBrowser} = nativeTab || tabTracker.activeTab;
              let tab = nativeTab && extension.tabManager.convert(nativeTab);
              context.withPendingBrowser(linkedBrowser,
                                         () => fire.sync(info, tab));
            };

            extension.on("webext-menu-menuitem-click", listener);
            return () => {
              extension.off("webext-menu-menuitem-click", listener);
            };
          },
        }).api(),
      },
    };
  }
};
