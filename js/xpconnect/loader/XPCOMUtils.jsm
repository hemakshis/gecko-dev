/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * vim: sw=2 ts=2 sts=2 et filetype=javascript
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Utilities for JavaScript components loaded by the JS component
 * loader.
 *
 * Import into a JS component using
 * 'Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");'
 *
 * Exposing a JS 'class' as a component using these utility methods consists
 * of several steps:
 * 0. Import XPCOMUtils, as described above.
 * 1. Declare the 'class' (or multiple classes) implementing the component(s):
 *  function MyComponent() {
 *    // constructor
 *  }
 *  MyComponent.prototype = {
 *    // properties required for XPCOM registration:
 *    classID:          Components.ID("{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"),
 *
 *    // [optional] custom factory (an object implementing nsIFactory). If not
 *    // provided, the default factory is used, which returns
 *    // |(new MyComponent()).QueryInterface(iid)| in its createInstance().
 *    _xpcom_factory: { ... },
 *
 *    // QueryInterface implementation, e.g. using the generateQI helper
 *    QueryInterface: ChromeUtils.generateQI(
 *      [Components.interfaces.nsIObserver,
 *       Components.interfaces.nsIMyInterface,
 *       "nsIFoo",
 *       "nsIBar" ]),
 *
 *    // The following properties were used prior to Mozilla 2, but are no
 *    // longer supported. They may still be included for compatibility with
 *    // prior versions of XPCOMUtils. In Mozilla 2, this information is
 *    // included in the .manifest file which registers this JS component.
 *    classDescription: "unique text description",
 *    contractID:       "@example.com/xxx;1",
 *
 *    // ...component implementation...
 *  };
 *
 * 2. Create an array of component constructors (like the one
 * created in step 1):
 *  var components = [MyComponent];
 *
 * 3. Define the NSGetFactory entry point:
 *  this.NSGetFactory = XPCOMUtils.generateNSGetFactory(components);
 */


var EXPORTED_SYMBOLS = [ "XPCOMUtils" ];

let global = Cu.getGlobalForObject({});

const nsIFactoryQI = ChromeUtils.generateQI([Ci.nsIFactory]);

/**
 * Redefines the given property on the given object with the given
 * value. This can be used to redefine getter properties which do not
 * implement setters.
 */
function redefine(object, prop, value) {
  Object.defineProperty(object, prop, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
  return value;
}

var XPCOMUtils = {
  /**
   * Generate a NSGetFactory function given an array of components.
   */
  generateNSGetFactory: function XPCU_generateNSGetFactory(componentsArray) {
    let classes = {};
    for (let i = 0; i < componentsArray.length; i++) {
        let component = componentsArray[i];
        if (!(component.prototype.classID instanceof Components.ID))
          throw Error("In generateNSGetFactory, classID missing or incorrect for component " + component);

        classes[component.prototype.classID] = this._getFactory(component);
    }
    return function NSGetFactory(cid) {
      let cidstring = cid.toString();
      if (cidstring in classes)
        return classes[cidstring];
      throw Cr.NS_ERROR_FACTORY_NOT_REGISTERED;
    }
  },

  /**
   * Defines a getter on a specified object that will be created upon first use.
   *
   * @param aObject
   *        The object to define the lazy getter on.
   * @param aName
   *        The name of the getter to define on aObject.
   * @param aLambda
   *        A function that returns what the getter should return.  This will
   *        only ever be called once.
   */
  defineLazyGetter: function XPCU_defineLazyGetter(aObject, aName, aLambda)
  {
    let redefining = false;
    Object.defineProperty(aObject, aName, {
      get: function () {
        if (!redefining) {
          // Make sure we don't get into an infinite recursion loop if
          // the getter lambda does something shady.
          redefining = true;
          return redefine(aObject, aName, aLambda.apply(aObject));
        }
      },
      configurable: true,
      enumerable: true
    });
  },

  /**
   * Defines a getter on a specified object for a script.  The script will not
   * be loaded until first use.
   *
   * @param aObject
   *        The object to define the lazy getter on.
   * @param aNames
   *        The name of the getter to define on aObject for the script.
   *        This can be a string if the script exports only one symbol,
   *        or an array of strings if the script can be first accessed
   *        from several different symbols.
   * @param aResource
   *        The URL used to obtain the script.
   */
  defineLazyScriptGetter: function XPCU_defineLazyScriptGetter(aObject, aNames,
                                                               aResource)
  {
    if (!Array.isArray(aNames)) {
      aNames = [aNames];
    }
    for (let name of aNames) {
      Object.defineProperty(aObject, name, {
        get: function() {
          Services.scriptloader.loadSubScript(aResource, aObject);
          return aObject[name];
        },
        set(value) {
          redefine(aObject, name, value);
        },
        configurable: true,
        enumerable: true
      });
    }
  },

  /**
   * Defines a getter property on the given object for each of the given
   * global names as accepted by Cu.importGlobalProperties. These
   * properties are imported into the shared JSM module global, and then
   * copied onto the given object, no matter which global the object
   * belongs to.
   *
   * @param {object} aObject
   *        The object on which to define the properties.
   * @param {string[]} aNames
   *        The list of global properties to define.
   */
  defineLazyGlobalGetters(aObject, aNames) {
    for (let name of aNames) {
      this.defineLazyGetter(aObject, name, () => {
        if (!(name in global)) {
          Cu.importGlobalProperties([name]);
        }
        return global[name];
      });
    }
  },

  /**
   * Defines a getter on a specified object for a service.  The service will not
   * be obtained until first use.
   *
   * @param aObject
   *        The object to define the lazy getter on.
   * @param aName
   *        The name of the getter to define on aObject for the service.
   * @param aContract
   *        The contract used to obtain the service.
   * @param aInterfaceName
   *        The name of the interface to query the service to.
   */
  defineLazyServiceGetter: function XPCU_defineLazyServiceGetter(aObject, aName,
                                                                 aContract,
                                                                 aInterfaceName)
  {
    this.defineLazyGetter(aObject, aName, function XPCU_serviceLambda() {
      if (aInterfaceName) {
        return Cc[aContract].getService(Ci[aInterfaceName]);
      }
      return Cc[aContract].getService().wrappedJSObject;
    });
  },

  /**
   * Defines a lazy service getter on a specified object for each
   * property in the given object.
   *
   * @param aObject
   *        The object to define the lazy getter on.
   * @param aServices
   *        An object with a property for each service to be
   *        imported, where the property name is the name of the
   *        symbol to define, and the value is a 1 or 2 element array
   *        containing the contract ID and, optionally, the interface
   *        name of the service, as passed to defineLazyServiceGetter.
   */
  defineLazyServiceGetters: function XPCU_defineLazyServiceGetters(
                                   aObject, aServices)
  {
    for (let [name, service] of Object.entries(aServices)) {
      // Note: This is hot code, and cross-compartment array wrappers
      // are not JIT-friendly to destructuring or spread operators, so
      // we need to use indexed access instead.
      this.defineLazyServiceGetter(aObject, name, service[0], service[1] || null);
    }
  },

  /**
   * Defines a getter on a specified object for a module.  The module will not
   * be imported until first use. The getter allows to execute setup and
   * teardown code (e.g.  to register/unregister to services) and accepts
   * a proxy object which acts on behalf of the module until it is imported.
   *
   * @param aObject
   *        The object to define the lazy getter on.
   * @param aName
   *        The name of the getter to define on aObject for the module.
   * @param aResource
   *        The URL used to obtain the module.
   * @param aSymbol
   *        The name of the symbol exported by the module.
   *        This parameter is optional and defaults to aName.
   * @param aPreLambda
   *        A function that is executed when the proxy is set up.
   *        This will only ever be called once.
   * @param aPostLambda
   *        A function that is executed when the module has been imported to
   *        run optional teardown procedures on the proxy object.
   *        This will only ever be called once.
   * @param aProxy
   *        An object which acts on behalf of the module to be imported until
   *        the module has been imported.
   */
  defineLazyModuleGetter: function XPCU_defineLazyModuleGetter(
                                   aObject, aName, aResource, aSymbol,
                                   aPreLambda, aPostLambda, aProxy)
  {
    if (arguments.length == 3) {
      return ChromeUtils.defineModuleGetter(aObject, aName, aResource);
    }

    let proxy = aProxy || {};

    if (typeof(aPreLambda) === "function") {
      aPreLambda.apply(proxy);
    }

    this.defineLazyGetter(aObject, aName, function XPCU_moduleLambda() {
      var temp = {};
      try {
        ChromeUtils.import(aResource, temp);

        if (typeof(aPostLambda) === "function") {
          aPostLambda.apply(proxy);
        }
      } catch (ex) {
        Cu.reportError("Failed to load module " + aResource + ".");
        throw ex;
      }
      return temp[aSymbol || aName];
    });
  },

  /**
   * Defines a lazy module getter on a specified object for each
   * property in the given object.
   *
   * @param aObject
   *        The object to define the lazy getter on.
   * @param aModules
   *        An object with a property for each module property to be
   *        imported, where the property name is the name of the
   *        imported symbol and the value is the module URI.
   */
  defineLazyModuleGetters: function XPCU_defineLazyModuleGetters(
                                   aObject, aModules)
  {
    for (let [name, module] of Object.entries(aModules)) {
      ChromeUtils.defineModuleGetter(aObject, name, module);
    }
  },

  /**
   * Defines a getter on a specified object for preference value. The
   * preference is read the first time that the property is accessed,
   * and is thereafter kept up-to-date using a preference observer.
   *
   * @param aObject
   *        The object to define the lazy getter on.
   * @param aName
   *        The name of the getter property to define on aObject.
   * @param aPreference
   *        The name of the preference to read.
   * @param aDefaultValue
   *        The default value to use, if the preference is not defined.
   * @param aOnUpdate
   *        A function to call upon update. Receives as arguments
   *         `(aPreference, previousValue, newValue)`
   * @param aTransform
   *        An optional function to transform the value.  If provided,
   *        this function receives the new preference value as an argument
   *        and its return value is used by the getter.
   */
  defineLazyPreferenceGetter: function XPCU_defineLazyPreferenceGetter(
                                   aObject, aName, aPreference,
                                   aDefaultValue = null,
                                   aOnUpdate = null,
                                   aTransform = val => val)
  {
    // Note: We need to keep a reference to this observer alive as long
    // as aObject is alive. This means that all of our getters need to
    // explicitly close over the variable that holds the object, and we
    // cannot define a value in place of a getter after we read the
    // preference.
    let observer = {
      QueryInterface: XPCU_lazyPreferenceObserverQI,

      value: undefined,

      observe(subject, topic, data) {
        if (data == aPreference) {
          if (aOnUpdate) {
            let previous = this.value;

            // Fetch and cache value.
            this.value = undefined;
            let latest = lazyGetter();
            aOnUpdate(data, previous, latest);
          } else {

            // Empty cache, next call to the getter will cause refetch.
            this.value = undefined;
          }
        }
      },
    }

    let defineGetter = get => {
      Object.defineProperty(aObject, aName, {
        configurable: true,
        enumerable: true,
        get,
      });
    };

    function lazyGetter() {
      if (observer.value === undefined) {
        let prefValue;
        switch (Services.prefs.getPrefType(aPreference)) {
          case Ci.nsIPrefBranch.PREF_STRING:
            prefValue = Services.prefs.getStringPref(aPreference);
            break;

          case Ci.nsIPrefBranch.PREF_INT:
            prefValue = Services.prefs.getIntPref(aPreference);
            break;

          case Ci.nsIPrefBranch.PREF_BOOL:
            prefValue = Services.prefs.getBoolPref(aPreference);
            break;

          case Ci.nsIPrefBranch.PREF_INVALID:
            prefValue = aDefaultValue;
            break;

          default:
            // This should never happen.
            throw new Error(`Error getting pref ${aPreference}; its value's type is ` +
                            `${Services.prefs.getPrefType(aPreference)}, which I don't ` +
                            `know how to handle.`);
        }

        observer.value = aTransform(prefValue);
      }
      return observer.value;
    }

    defineGetter(() => {
      Services.prefs.addObserver(aPreference, observer, true);

      defineGetter(lazyGetter);
      return lazyGetter();
    });
  },

  /**
   * Helper which iterates over a string enumerator.
   * @param e The string enumerator (nsIUTF8StringEnumerator or
   *          nsIStringEnumerator) over which to iterate.
   */
  IterStringEnumerator: function* XPCU_IterStringEnumerator(e)
  {
    while (e.hasMore())
      yield e.getNext();
  },

  /**
   * Helper which iterates over the entries in a category.
   * @param aCategory The name of the category over which to iterate.
   */
  enumerateCategoryEntries: function* XPCOMUtils_enumerateCategoryEntries(aCategory)
  {
    let category = this.categoryManager.enumerateCategory(aCategory);
    for (let entry of category) {
      yield [entry.data, this.categoryManager.getCategoryEntry(aCategory, entry.data)];
    }
  },

  /**
   * Returns an nsIFactory for |component|.
   */
  _getFactory: function XPCOMUtils__getFactory(component) {
    var factory = component.prototype._xpcom_factory;
    if (!factory) {
      factory = {
        createInstance: function(outer, iid) {
          if (outer)
            throw Cr.NS_ERROR_NO_AGGREGATION;
          return (new component()).QueryInterface(iid);
        },
        QueryInterface: nsIFactoryQI
      }
    }
    return factory;
  },

  /**
   * generates a singleton nsIFactory implementation that can be used as
   * the _xpcom_factory of the component.
   * @param aServiceConstructor
   *        Constructor function of the component.
   */
  generateSingletonFactory:
  function XPCOMUtils_generateSingletonFactory(aServiceConstructor) {
    return {
      _instance: null,
      createInstance: function XPCU_SF_createInstance(aOuter, aIID) {
        if (aOuter !== null) {
          throw Cr.NS_ERROR_NO_AGGREGATION;
        }
        if (this._instance === null) {
          this._instance = new aServiceConstructor();
        }
        return this._instance.QueryInterface(aIID);
      },
      QueryInterface: nsIFactoryQI
    };
  },

  /**
   * Defines a non-writable property on an object.
   */
  defineConstant: function XPCOMUtils__defineConstant(aObj, aName, aValue) {
    Object.defineProperty(aObj, aName, {
      value: aValue,
      enumerable: true,
      writable: false
    });
  },

  /**
   * Defines a proxy which acts as a lazy object getter that can be passed
   * around as a reference, and will only be evaluated when something in
   * that object gets accessed.
   *
   * The evaluation can be triggered by a function call, by getting or
   * setting a property, calling this as a constructor, or enumerating
   * the properties of this object (e.g. during an iteration).
   *
   * Please note that, even after evaluated, the object given to you
   * remains being the proxy object (which forwards everything to the
   * real object). This is important to correctly use these objects
   * in pairs of add+remove listeners, for example.
   * If your use case requires access to the direct object, you can
   * get it through the untrap callback.
   *
   * @param aObject
   *        The object to define the lazy getter on.
   *
   *        You can pass null to aObject if you just want to get this
   *        proxy through the return value.
   *
   * @param aName
   *        The name of the getter to define on aObject.
   *
   * @param aInitFuncOrResource
   *        A function or a module that defines what this object actually
   *        should be when it gets evaluated. This will only ever be called once.
   *
   *        Short-hand: If you pass a string to this parameter, it will be treated
   *        as the URI of a module to be imported, and aName will be used as
   *        the symbol to retrieve from the module.
   *
   * @param aStubProperties
   *        In this parameter, you can provide an object which contains
   *        properties from the original object that, when accessed, will still
   *        prevent the entire object from being evaluated.
   *
   *        These can be copies or simplified versions of the original properties.
   *
   *        One example is to provide an alternative QueryInterface implementation
   *        to avoid the entire object from being evaluated when it's added as an
   *        observer (as addObserver calls object.QueryInterface(Ci.nsIObserver)).
   *
   *        Once the object has been evaluated, the properties from the real
   *        object will be used instead of the ones provided here.
   *
   * @param aUntrapCallback
   *        A function that gets called once when the object has just been evaluated.
   *        You can use this to do some work (e.g. setting properties) that you need
   *        to do on this object but that can wait until it gets evaluated.
   *
   *        Another use case for this is to use during code development to log when
   *        this object gets evaluated, to make sure you're not accidentally triggering
   *        it earlier than expected.
   */
  defineLazyProxy: function XPCOMUtils__defineLazyProxy(aObject, aName, aInitFuncOrResource,
                                                        aStubProperties, aUntrapCallback) {
    let initFunc = aInitFuncOrResource;

    if (typeof(aInitFuncOrResource) == "string") {
      initFunc = function () {
        let tmp = {};
        ChromeUtils.import(aInitFuncOrResource, tmp);
        return tmp[aName];
      };
    }

    let handler = new LazyProxyHandler(aName, initFunc,
                                       aStubProperties, aUntrapCallback);

    /*
     * We cannot simply create a lazy getter for the underlying
     * object and pass it as the target of the proxy, because
     * just passing it in `new Proxy` means it would get
     * evaluated. Becase of this, a full handler needs to be
     * implemented (the LazyProxyHandler).
     *
     * So, an empty object is used as the target, and the handler
     * replaces it on every call with the real object.
     */
    let proxy = new Proxy({}, handler);

    if (aObject) {
      Object.defineProperty(aObject, aName, {
        value: proxy,
        enumerable: true,
        writable: true,
      });
    }

    return proxy;
  },
};

/**
 * LazyProxyHandler
 * This class implements the handler used
 * in the proxy from defineLazyProxy.
 *
 * This handler forwards all calls to an underlying object,
 * stored as `this.realObject`, which is obtained as the returned
 * value from aInitFunc, which will be called on the first time
 * time that it needs to be used (with an exception in the get() trap
 * for the properties provided in the `aStubProperties` parameter).
 */

class LazyProxyHandler {
  constructor(aName, aInitFunc, aStubProperties, aUntrapCallback) {
    this.pending = true;
    this.name = aName;
    this.initFuncOrResource = aInitFunc;
    this.stubProperties = aStubProperties;
    this.untrapCallback = aUntrapCallback;
  }

  getObject() {
    if (this.pending) {
      this.realObject = this.initFuncOrResource.call(null);

      if (this.untrapCallback) {
        this.untrapCallback.call(null, this.realObject);
        this.untrapCallback = null;
      }

      this.pending = false;
      this.stubProperties = null;
    }
    return this.realObject;
  }

  getPrototypeOf(target) {
    return Reflect.getPrototypeOf(this.getObject());
  }

  setPrototypeOf(target, prototype) {
    return Reflect.setPrototypeOf(this.getObject(), prototype);
  }

  isExtensible(target) {
    return Reflect.isExtensible(this.getObject());
  }

  preventExtensions(target) {
    return Reflect.preventExtensions(this.getObject());
  }

  getOwnPropertyDescriptor(target, prop) {
    return Reflect.getOwnPropertyDescriptor(this.getObject(), prop);
  }

  defineProperty(target, prop, descriptor) {
    return Reflect.defineProperty(this.getObject(), prop, descriptor);
  }

  has(target, prop) {
    return Reflect.has(this.getObject(), prop);
  }

  get(target, prop, receiver) {
    if (this.pending &&
        this.stubProperties &&
        Object.prototype.hasOwnProperty.call(this.stubProperties, prop)) {
      return this.stubProperties[prop];
    }
    return Reflect.get(this.getObject(), prop, receiver);
  }

  set(target, prop, value, receiver) {
    return Reflect.set(this.getObject(), prop, value, receiver);
  }

  deleteProperty(target, prop) {
    return Reflect.deleteProperty(this.getObject(), prop);
  }

  ownKeys(target) {
    return Reflect.ownKeys(this.getObject());
  }
}

var XPCU_lazyPreferenceObserverQI = ChromeUtils.generateQI([Ci.nsIObserver, Ci.nsISupportsWeakReference]);

ChromeUtils.defineModuleGetter(this, "Services",
                               "resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyServiceGetter(XPCOMUtils, "categoryManager",
                                   "@mozilla.org/categorymanager;1",
                                   "nsICategoryManager");
