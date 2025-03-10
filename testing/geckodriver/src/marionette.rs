use base64;
use hyper::Method;
use mozprofile::preferences::Pref;
use mozprofile::profile::Profile;
use mozrunner::runner::{FirefoxProcess, FirefoxRunner, Runner, RunnerProcess};
use regex::Captures;
use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, Serializer};
use serde_json::{self, Map, Value};
use std::env;
use std::error::Error;
use std::fs::File;
use std::io::prelude::*;
use std::io::Error as IoError;
use std::io::ErrorKind;
use std::io::Result as IoResult;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time;
use uuid::Uuid;
use webdriver::capabilities::CapabilitiesMatching;
use webdriver::command::WebDriverCommand::{AcceptAlert, AddCookie, CloseWindow, DeleteCookie,
                                           DeleteCookies, DeleteSession, DismissAlert,
                                           ElementClear, ElementClick, ElementSendKeys,
                                           ElementTap, ExecuteAsyncScript, ExecuteScript,
                                           Extension, FindElement, FindElementElement,
                                           FindElementElements, FindElements, FullscreenWindow,
                                           Get, GetActiveElement, GetAlertText, GetCSSValue,
                                           GetCookies, GetCurrentUrl, GetElementAttribute,
                                           GetElementProperty, GetElementRect, GetElementTagName,
                                           GetElementText, GetNamedCookie, GetPageSource,
                                           GetTimeouts, GetTitle, GetWindowHandle,
                                           GetWindowHandles, GetWindowRect, GoBack, GoForward,
                                           IsDisplayed, IsEnabled, IsSelected, MaximizeWindow,
                                           MinimizeWindow, NewSession, PerformActions, Refresh,
                                           ReleaseActions, SendAlertText, SetTimeouts,
                                           SetWindowRect, Status, SwitchToFrame,
                                           SwitchToParentFrame, SwitchToWindow,
                                           TakeElementScreenshot, TakeScreenshot};
use webdriver::command::{ActionsParameters, AddCookieParameters, GetNamedCookieParameters,
                         GetParameters, JavascriptCommandParameters, LocatorParameters,
                         NewSessionParameters, SwitchToFrameParameters, SwitchToWindowParameters,
                         TakeScreenshotParameters, TimeoutsParameters, WindowRectParameters};
use webdriver::command::{WebDriverCommand, WebDriverExtensionCommand, WebDriverMessage};
use webdriver::common::{Cookie, FrameId, WebElement, ELEMENT_KEY, FRAME_KEY, WINDOW_KEY};
use webdriver::error::{ErrorStatus, WebDriverError, WebDriverResult};
use webdriver::httpapi::WebDriverExtensionRoute;
use webdriver::response::{CloseWindowResponse, CookieResponse, CookiesResponse,
                          ElementRectResponse, NewSessionResponse, TimeoutsResponse,
                          ValueResponse, WebDriverResponse, WindowRectResponse};
use webdriver::server::{Session, WebDriverHandler};

use build::BuildInfo;
use capabilities::{FirefoxCapabilities, FirefoxOptions};
use logging;
use prefs;

// localhost may be routed to the IPv6 stack on certain systems,
// and nsIServerSocket in Marionette only supports IPv4
const DEFAULT_HOST: &'static str = "127.0.0.1";

const CHROME_ELEMENT_KEY: &'static str = "chromeelement-9fc5-4b51-a3c8-01716eedeb04";
const LEGACY_ELEMENT_KEY: &'static str = "ELEMENT";

pub fn extension_routes() -> Vec<(Method, &'static str, GeckoExtensionRoute)> {
    return vec![
        (
            Method::GET,
            "/session/{sessionId}/moz/context",
            GeckoExtensionRoute::GetContext,
        ),
        (
            Method::POST,
            "/session/{sessionId}/moz/context",
            GeckoExtensionRoute::SetContext,
        ),
        (
            Method::POST,
            "/session/{sessionId}/moz/xbl/{elementId}/anonymous_children",
            GeckoExtensionRoute::XblAnonymousChildren,
        ),
        (
            Method::POST,
            "/session/{sessionId}/moz/xbl/{elementId}/anonymous_by_attribute",
            GeckoExtensionRoute::XblAnonymousByAttribute,
        ),
        (
            Method::POST,
            "/session/{sessionId}/moz/addon/install",
            GeckoExtensionRoute::InstallAddon,
        ),
        (
            Method::POST,
            "/session/{sessionId}/moz/addon/uninstall",
            GeckoExtensionRoute::UninstallAddon,
        ),
    ];
}

#[derive(Clone, PartialEq)]
pub enum GeckoExtensionRoute {
    GetContext,
    SetContext,
    XblAnonymousChildren,
    XblAnonymousByAttribute,
    InstallAddon,
    UninstallAddon,
}

impl WebDriverExtensionRoute for GeckoExtensionRoute {
    type Command = GeckoExtensionCommand;

    fn command(
        &self,
        params: &Captures,
        body_data: &Value,
    ) -> WebDriverResult<WebDriverCommand<GeckoExtensionCommand>> {
        let command = match self {
            &GeckoExtensionRoute::GetContext => GeckoExtensionCommand::GetContext,
            &GeckoExtensionRoute::SetContext => {
                GeckoExtensionCommand::SetContext(serde_json::from_value(body_data.clone())?)
            }
            &GeckoExtensionRoute::XblAnonymousChildren => {
                let element_id = try_opt!(
                    params.name("elementId"),
                    ErrorStatus::InvalidArgument,
                    "Missing elementId parameter"
                );
                let element = WebElement::new(element_id.as_str().to_string());
                GeckoExtensionCommand::XblAnonymousChildren(element)
            }
            &GeckoExtensionRoute::XblAnonymousByAttribute => {
                let element_id = try_opt!(
                    params.name("elementId"),
                    ErrorStatus::InvalidArgument,
                    "Missing elementId parameter"
                );
                GeckoExtensionCommand::XblAnonymousByAttribute(
                    WebElement::new(element_id.as_str().into()),
                    serde_json::from_value(body_data.clone())?,
                )
            }
            &GeckoExtensionRoute::InstallAddon => {
                GeckoExtensionCommand::InstallAddon(serde_json::from_value(body_data.clone())?)
            }
            &GeckoExtensionRoute::UninstallAddon => {
                GeckoExtensionCommand::UninstallAddon(serde_json::from_value(body_data.clone())?)
            }
        };
        Ok(WebDriverCommand::Extension(command))
    }
}

#[derive(Clone, PartialEq)]
pub enum GeckoExtensionCommand {
    GetContext,
    SetContext(GeckoContextParameters),
    XblAnonymousChildren(WebElement),
    XblAnonymousByAttribute(WebElement, XblLocatorParameters),
    InstallAddon(AddonInstallParameters),
    UninstallAddon(AddonUninstallParameters),
}

impl WebDriverExtensionCommand for GeckoExtensionCommand {
    fn parameters_json(&self) -> Option<Value> {
        match self {
            &GeckoExtensionCommand::GetContext => None,
            &GeckoExtensionCommand::InstallAddon(ref x) => {
                Some(serde_json::to_value(x.clone()).unwrap())
            }
            &GeckoExtensionCommand::SetContext(ref x) => {
                Some(serde_json::to_value(x.clone()).unwrap())
            }
            &GeckoExtensionCommand::UninstallAddon(ref x) => {
                Some(serde_json::to_value(x.clone()).unwrap())
            }
            &GeckoExtensionCommand::XblAnonymousByAttribute(_, ref x) => {
                Some(serde_json::to_value(x.clone()).unwrap())
            }
            &GeckoExtensionCommand::XblAnonymousChildren(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AddonInstallParameters {
    pub path: String,
    pub temporary: bool,
}

impl<'de> Deserialize<'de> for AddonInstallParameters {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Debug, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Base64 {
            addon: String,
            temporary: bool,
        };

        #[derive(Debug, Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Path {
            path: String,
            temporary: bool,
        };

        #[derive(Debug, Deserialize)]
        #[serde(untagged)]
        enum Helper {
            Base64(Base64),
            Path(Path),
        };

        let params = match Helper::deserialize(deserializer)? {
            Helper::Path(ref mut data) => AddonInstallParameters {
                path: data.path.clone(),
                temporary: data.temporary,
            },
            Helper::Base64(ref mut data) => {
                let content = base64::decode(&data.addon).map_err(de::Error::custom)?;

                let path = env::temp_dir()
                    .as_path()
                    .join(format!("addon-{}.xpi", Uuid::new_v4()));
                let mut xpi_file = File::create(&path).map_err(de::Error::custom)?;
                xpi_file
                    .write(content.as_slice())
                    .map_err(de::Error::custom)?;

                let path = match path.to_str() {
                    Some(path) => path.to_string(),
                    None => return Err(de::Error::custom("could not write addon to file")),
                };

                AddonInstallParameters {
                    path: path,
                    temporary: data.temporary,
                }
            }
        };

        Ok(params)
    }
}

impl ToMarionette for AddonInstallParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = Map::new();
        data.insert("path".to_string(), Value::String(self.path.clone()));
        data.insert("temporary".to_string(), Value::Bool(self.temporary));
        Ok(data)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AddonUninstallParameters {
    pub id: String,
}

impl ToMarionette for AddonUninstallParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = Map::new();
        data.insert("id".to_string(), Value::String(self.id.clone()));
        Ok(data)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum GeckoContext {
    Content,
    Chrome,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GeckoContextParameters {
    context: GeckoContext,
}

impl ToMarionette for GeckoContextParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = Map::new();
        data.insert(
            "value".to_owned(),
            serde_json::to_value(self.context.clone())?,
        );
        Ok(data)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct XblLocatorParameters {
    name: String,
    value: String,
}

impl ToMarionette for XblLocatorParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut value = Map::new();
        value.insert(self.name.to_owned(), Value::String(self.value.clone()));

        let mut data = Map::new();
        data.insert(
            "using".to_owned(),
            Value::String("anon attribute".to_string()),
        );
        data.insert("value".to_owned(), Value::Object(value));
        Ok(data)
    }
}

#[derive(Default, Debug)]
pub struct LogOptions {
    pub level: Option<logging::Level>,
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct MarionetteHandshake {
    #[serde(rename = "marionetteProtocol")]
    protocol: u16,
    #[serde(rename = "applicationType")]
    application_type: String,
}

#[derive(Default)]
pub struct MarionetteSettings {
    pub port: Option<u16>,
    pub binary: Option<PathBuf>,
    pub connect_existing: bool,

    /// Brings up the Browser Toolbox when starting Firefox,
    /// letting you debug internals.
    pub jsdebugger: bool,
}

#[derive(Default)]
pub struct MarionetteHandler {
    connection: Mutex<Option<MarionetteConnection>>,
    settings: MarionetteSettings,
    browser: Option<FirefoxProcess>,
}

impl MarionetteHandler {
    pub fn new(settings: MarionetteSettings) -> MarionetteHandler {
        MarionetteHandler {
            connection: Mutex::new(None),
            settings,
            browser: None,
        }
    }

    fn create_connection(
        &mut self,
        session_id: &Option<String>,
        new_session_parameters: &NewSessionParameters,
    ) -> WebDriverResult<Map<String, Value>> {
        let (options, capabilities) = {
            let mut fx_capabilities = FirefoxCapabilities::new(self.settings.binary.as_ref());
            let mut capabilities = try!(
                try!(new_session_parameters.match_browser(&mut fx_capabilities)).ok_or(
                    WebDriverError::new(
                        ErrorStatus::SessionNotCreated,
                        "Unable to find a matching set of capabilities",
                    ),
                )
            );

            let options = try!(FirefoxOptions::from_capabilities(
                fx_capabilities.chosen_binary,
                &mut capabilities
            ));
            (options, capabilities)
        };

        if let Some(l) = options.log.level {
            logging::set_max_level(l);
        }

        let port = self.settings.port.unwrap_or(get_free_port()?);
        if !self.settings.connect_existing {
            try!(self.start_browser(port, options));
        }

        let mut connection = MarionetteConnection::new(port, session_id.clone());
        connection.connect(&mut self.browser)?;
        self.connection = Mutex::new(Some(connection));
        Ok(capabilities)
    }

    fn start_browser(&mut self, port: u16, options: FirefoxOptions) -> WebDriverResult<()> {
        let binary = options.binary.ok_or(WebDriverError::new(
            ErrorStatus::SessionNotCreated,
            "Expected browser binary location, but unable to find \
             binary in default location, no \
             'moz:firefoxOptions.binary' capability provided, and \
             no binary flag set on the command line",
        ))?;

        let is_custom_profile = options.profile.is_some();

        let mut profile = match options.profile {
            Some(x) => x,
            None => Profile::new(None)?,
        };

        self.set_prefs(port, &mut profile, is_custom_profile, options.prefs)
            .map_err(|e| {
                WebDriverError::new(
                    ErrorStatus::SessionNotCreated,
                    format!("Failed to set preferences: {}", e),
                )
            })?;

        let mut runner = FirefoxRunner::new(&binary, profile);

        // https://developer.mozilla.org/docs/Environment_variables_affecting_crash_reporting
        runner
            .env("MOZ_CRASHREPORTER", "1")
            .env("MOZ_CRASHREPORTER_NO_REPORT", "1")
            .env("MOZ_CRASHREPORTER_SHUTDOWN", "1");

        // double-dashed flags are not accepted on Windows systems
        runner.arg("-marionette");
        if self.settings.jsdebugger {
            runner.arg("-jsdebugger");
        }
        if let Some(args) = options.args.as_ref() {
            runner.args(args);
        }

        let browser_proc = runner.start().map_err(|e| {
            WebDriverError::new(
                ErrorStatus::SessionNotCreated,
                format!("Failed to start browser {}: {}", binary.display(), e),
            )
        })?;
        self.browser = Some(browser_proc);

        Ok(())
    }

    pub fn set_prefs(
        &self,
        port: u16,
        profile: &mut Profile,
        custom_profile: bool,
        extra_prefs: Vec<(String, Pref)>,
    ) -> WebDriverResult<()> {
        let prefs = profile.user_prefs().map_err(|_| {
            WebDriverError::new(
                ErrorStatus::UnknownError,
                "Unable to read profile preferences file",
            )
        })?;

        for &(ref name, ref value) in prefs::DEFAULT.iter() {
            if !custom_profile || !prefs.contains_key(name) {
                prefs.insert((*name).clone(), (*value).clone());
            }
        }

        prefs.insert_slice(&extra_prefs[..]);

        if self.settings.jsdebugger {
            prefs.insert(
                "devtools.browsertoolbox.panel",
                Pref::new("jsdebugger".to_owned()),
            );
            prefs.insert("devtools.debugger.remote-enabled", Pref::new(true));
            prefs.insert("devtools.chrome.enabled", Pref::new(true));
            prefs.insert("devtools.debugger.prompt-connection", Pref::new(false));
            prefs.insert("marionette.debugging.clicktostart", Pref::new(true));
        }

        prefs.insert(
            "marionette.log.level",
            Pref::new(logging::max_level().to_string()),
        );
        prefs.insert("marionette.port", Pref::new(port));

        prefs.write().map_err(|_| {
            WebDriverError::new(ErrorStatus::UnknownError, "Unable to write Firefox profile")
        })
    }
}

impl WebDriverHandler<GeckoExtensionRoute> for MarionetteHandler {
    fn handle_command(
        &mut self,
        _: &Option<Session>,
        msg: WebDriverMessage<GeckoExtensionRoute>,
    ) -> WebDriverResult<WebDriverResponse> {
        let mut resolved_capabilities = None;
        {
            let mut capabilities_options = None;
            // First handle the status message which doesn't actually require a marionette
            // connection or message
            if msg.command == Status {
                let (ready, message) = self.connection
                    .lock()
                    .map(|ref connection| {
                        connection
                            .as_ref()
                            .map(|_| (false, "Session already started"))
                            .unwrap_or((true, ""))
                    })
                    .unwrap_or((false, "geckodriver internal error"));
                let mut value = Map::new();
                value.insert("ready".to_string(), Value::Bool(ready));
                value.insert("message".to_string(), Value::String(message.into()));
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Object(
                    value,
                ))));
            }

            match self.connection.lock() {
                Ok(ref connection) => {
                    if connection.is_none() {
                        match msg.command {
                            NewSession(ref capabilities) => {
                                capabilities_options = Some(capabilities);
                            }
                            _ => {
                                return Err(WebDriverError::new(
                                    ErrorStatus::InvalidSessionId,
                                    "Tried to run command without establishing a connection",
                                ));
                            }
                        }
                    }
                }
                Err(_) => {
                    return Err(WebDriverError::new(
                        ErrorStatus::UnknownError,
                        "Failed to aquire Marionette connection",
                    ))
                }
            }
            if let Some(capabilities) = capabilities_options {
                resolved_capabilities =
                    Some(try!(self.create_connection(&msg.session_id, &capabilities)));
            }
        }

        match self.connection.lock() {
            Ok(ref mut connection) => {
                match connection.as_mut() {
                    Some(conn) => {
                        conn.send_command(resolved_capabilities, &msg)
                            .map_err(|mut err| {
                                // Shutdown the browser if no session can
                                // be established due to errors.
                                if let NewSession(_) = msg.command {
                                    err.delete_session = true;
                                }
                                err
                            })
                    }
                    None => panic!("Connection missing"),
                }
            }
            Err(_) => Err(WebDriverError::new(
                ErrorStatus::UnknownError,
                "Failed to aquire Marionette connection",
            )),
        }
    }

    fn delete_session(&mut self, session: &Option<Session>) {
        if let Some(ref s) = *session {
            let delete_session = WebDriverMessage {
                session_id: Some(s.id.clone()),
                command: WebDriverCommand::DeleteSession,
            };
            let _ = self.handle_command(session, delete_session);
        }

        if let Ok(ref mut connection) = self.connection.lock() {
            if let Some(conn) = connection.as_mut() {
                conn.close();
            }
        }

        if let Some(ref mut runner) = self.browser {
            // TODO(https://bugzil.la/1443922):
            // Use toolkit.asyncshutdown.crash_timout pref
            match runner.wait(time::Duration::from_secs(70)) {
                Ok(x) => debug!("Browser process stopped: {}", x),
                Err(e) => error!("Failed to stop browser process: {}", e),
            }
        }

        self.connection = Mutex::new(None);
        self.browser = None;
    }
}

pub struct MarionetteSession {
    pub session_id: String,
    protocol: Option<u16>,
    application_type: Option<String>,
    command_id: u64,
}

impl MarionetteSession {
    pub fn new(session_id: Option<String>) -> MarionetteSession {
        let initital_id = session_id.unwrap_or("".to_string());
        MarionetteSession {
            session_id: initital_id,
            protocol: None,
            application_type: None,
            command_id: 0,
        }
    }

    pub fn update(
        &mut self,
        msg: &WebDriverMessage<GeckoExtensionRoute>,
        resp: &MarionetteResponse,
    ) -> WebDriverResult<()> {
        match msg.command {
            NewSession(_) => {
                let session_id = try_opt!(
                    try_opt!(
                        resp.result.get("sessionId"),
                        ErrorStatus::SessionNotCreated,
                        "Unable to get session id"
                    ).as_str(),
                    ErrorStatus::SessionNotCreated,
                    "Unable to convert session id to string"
                );
                self.session_id = session_id.to_string().clone();
            }
            _ => {}
        }
        Ok(())
    }

    /// Converts a Marionette JSON response into a `WebElement`.
    ///
    /// Note that it currently coerces all chrome elements, web frames, and web
    /// windows also into web elements.  This will change at a later point.
    fn to_web_element(&self, json_data: &Value) -> WebDriverResult<WebElement> {
        let data = try_opt!(
            json_data.as_object(),
            ErrorStatus::UnknownError,
            "Failed to convert data to an object"
        );

        let chrome_element = data.get(CHROME_ELEMENT_KEY);
        let element = data.get(ELEMENT_KEY);
        let frame = data.get(FRAME_KEY);
        let legacy_element = data.get(LEGACY_ELEMENT_KEY);
        let window = data.get(WINDOW_KEY);

        let value = try_opt!(
            element
                .or(legacy_element)
                .or(chrome_element)
                .or(frame)
                .or(window),
            ErrorStatus::UnknownError,
            "Failed to extract web element from Marionette response"
        );
        let id = try_opt!(
            value.as_str(),
            ErrorStatus::UnknownError,
            "Failed to convert web element reference value to string"
        ).to_string();
        Ok(WebElement::new(id))
    }

    pub fn next_command_id(&mut self) -> u64 {
        self.command_id = self.command_id + 1;
        self.command_id
    }

    pub fn response(
        &mut self,
        msg: &WebDriverMessage<GeckoExtensionRoute>,
        resp: MarionetteResponse,
    ) -> WebDriverResult<WebDriverResponse> {
        if resp.id != self.command_id {
            return Err(WebDriverError::new(
                ErrorStatus::UnknownError,
                format!(
                    "Marionette responses arrived out of sequence, expected {}, got {}",
                    self.command_id, resp.id
                ),
            ));
        }

        if let Some(error) = resp.error {
            return Err(error.into());
        }

        try!(self.update(msg, &resp));

        Ok(match msg.command {
            // Everything that doesn't have a response value
            Get(_)
            | GoBack
            | GoForward
            | Refresh
            | SetTimeouts(_)
            | SwitchToWindow(_)
            | SwitchToFrame(_)
            | SwitchToParentFrame
            | AddCookie(_)
            | DeleteCookies
            | DeleteCookie(_)
            | DismissAlert
            | AcceptAlert
            | SendAlertText(_)
            | ElementClick(_)
            | ElementTap(_)
            | ElementClear(_)
            | ElementSendKeys(_, _)
            | PerformActions(_)
            | ReleaseActions => WebDriverResponse::Void,
            // Things that simply return the contents of the marionette "value" property
            GetCurrentUrl
            | GetTitle
            | GetPageSource
            | GetWindowHandle
            | IsDisplayed(_)
            | IsSelected(_)
            | GetElementAttribute(_, _)
            | GetElementProperty(_, _)
            | GetCSSValue(_, _)
            | GetElementText(_)
            | GetElementTagName(_)
            | IsEnabled(_)
            | ExecuteScript(_)
            | ExecuteAsyncScript(_)
            | GetAlertText
            | TakeScreenshot
            | TakeElementScreenshot(_) => WebDriverResponse::Generic(resp.to_value_response(true)?),
            GetTimeouts => {
                let script = try_opt!(
                    try_opt!(
                        resp.result.get("script"),
                        ErrorStatus::UnknownError,
                        "Missing field: script"
                    ).as_u64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret script timeout duration as u64"
                );
                // Check for the spec-compliant "pageLoad", but also for "page load",
                // which was sent by Firefox 52 and earlier.
                let page_load = try_opt!(
                    try_opt!(
                        resp.result.get("pageLoad").or(resp.result.get("page load")),
                        ErrorStatus::UnknownError,
                        "Missing field: pageLoad"
                    ).as_u64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret page load duration as u64"
                );
                let implicit = try_opt!(
                    try_opt!(
                        resp.result.get("implicit"),
                        ErrorStatus::UnknownError,
                        "Missing field: implicit"
                    ).as_u64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret implicit search duration as u64"
                );

                WebDriverResponse::Timeouts(TimeoutsResponse {
                    script: script,
                    pageLoad: page_load,
                    implicit: implicit,
                })
            }
            Status => panic!("Got status command that should already have been handled"),
            GetWindowHandles => WebDriverResponse::Generic(resp.to_value_response(false)?),
            CloseWindow => {
                let data = try_opt!(
                    resp.result.as_array(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret value as array"
                );
                let handles = try!(
                    data.iter()
                        .map(|x| {
                            Ok(try_opt!(
                                x.as_str(),
                                ErrorStatus::UnknownError,
                                "Failed to interpret window handle as string"
                            ).to_owned())
                        })
                        .collect()
                );
                WebDriverResponse::CloseWindow(CloseWindowResponse(handles))
            }
            GetElementRect(_) => {
                let x = try_opt!(
                    try_opt!(
                        resp.result.get("x"),
                        ErrorStatus::UnknownError,
                        "Failed to find x field"
                    ).as_f64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret x as float"
                );

                let y = try_opt!(
                    try_opt!(
                        resp.result.get("y"),
                        ErrorStatus::UnknownError,
                        "Failed to find y field"
                    ).as_f64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret y as float"
                );

                let width = try_opt!(
                    try_opt!(
                        resp.result.get("width"),
                        ErrorStatus::UnknownError,
                        "Failed to find width field"
                    ).as_f64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret width as float"
                );

                let height = try_opt!(
                    try_opt!(
                        resp.result.get("height"),
                        ErrorStatus::UnknownError,
                        "Failed to find height field"
                    ).as_f64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret width as float"
                );

                let rect = ElementRectResponse {
                    x,
                    y,
                    width,
                    height,
                };
                WebDriverResponse::ElementRect(rect)
            }
            FullscreenWindow | MinimizeWindow | MaximizeWindow | GetWindowRect
            | SetWindowRect(_) => {
                let width = try_opt!(
                    try_opt!(
                        resp.result.get("width"),
                        ErrorStatus::UnknownError,
                        "Failed to find width field"
                    ).as_u64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret width as positive integer"
                );

                let height = try_opt!(
                    try_opt!(
                        resp.result.get("height"),
                        ErrorStatus::UnknownError,
                        "Failed to find heigenht field"
                    ).as_u64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret height as positive integer"
                );

                let x = try_opt!(
                    try_opt!(
                        resp.result.get("x"),
                        ErrorStatus::UnknownError,
                        "Failed to find x field"
                    ).as_i64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret x as integer"
                );

                let y = try_opt!(
                    try_opt!(
                        resp.result.get("y"),
                        ErrorStatus::UnknownError,
                        "Failed to find y field"
                    ).as_i64(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret y as integer"
                );

                let rect = WindowRectResponse {
                    x: x as i32,
                    y: y as i32,
                    width: width as i32,
                    height: height as i32,
                };
                WebDriverResponse::WindowRect(rect)
            }
            GetCookies => {
                let cookies: Vec<Cookie> = serde_json::from_value(resp.result)?;
                WebDriverResponse::Cookies(CookiesResponse(cookies))
            }
            GetNamedCookie(ref name) => {
                let mut cookies: Vec<Cookie> = serde_json::from_value(resp.result)?;
                cookies.retain(|x| x.name == *name);
                let cookie = try_opt!(
                    cookies.pop(),
                    ErrorStatus::NoSuchCookie,
                    format!("No cookie with name {}", name)
                );
                WebDriverResponse::Cookie(CookieResponse(cookie))
            }
            FindElement(_) | FindElementElement(_, _) => {
                let element = try!(self.to_web_element(try_opt!(
                    resp.result.get("value"),
                    ErrorStatus::UnknownError,
                    "Failed to find value field"
                )));
                WebDriverResponse::Generic(ValueResponse(serde_json::to_value(element)?))
            }
            FindElements(_) | FindElementElements(_, _) => {
                let element_vec = try_opt!(
                    resp.result.as_array(),
                    ErrorStatus::UnknownError,
                    "Failed to interpret value as array"
                );
                let elements = try!(
                    element_vec
                        .iter()
                        .map(|x| self.to_web_element(x))
                        .collect::<Result<Vec<_>, _>>()
                );
                // TODO(Henrik): How to remove unwrap?
                WebDriverResponse::Generic(ValueResponse(Value::Array(
                    elements
                        .iter()
                        .map(|x| serde_json::to_value(x).unwrap())
                        .collect(),
                )))
            }
            GetActiveElement => {
                let element = try!(self.to_web_element(try_opt!(
                    resp.result.get("value"),
                    ErrorStatus::UnknownError,
                    "Failed to find value field"
                )));
                WebDriverResponse::Generic(ValueResponse(serde_json::to_value(element)?))
            }
            NewSession(_) => {
                let session_id = try_opt!(
                    try_opt!(
                        resp.result.get("sessionId"),
                        ErrorStatus::InvalidSessionId,
                        "Failed to find sessionId field"
                    ).as_str(),
                    ErrorStatus::InvalidSessionId,
                    "sessionId is not a string"
                );

                let mut capabilities = try_opt!(
                    try_opt!(
                        resp.result.get("capabilities"),
                        ErrorStatus::UnknownError,
                        "Failed to find capabilities field"
                    ).as_object(),
                    ErrorStatus::UnknownError,
                    "capabilities field is not an object"
                ).clone();

                capabilities.insert("moz:geckodriverVersion".into(), BuildInfo.into());

                WebDriverResponse::NewSession(NewSessionResponse::new(
                    session_id.to_string(),
                    Value::Object(capabilities.clone()),
                ))
            }
            DeleteSession => WebDriverResponse::DeleteSession,
            Extension(ref extension) => match extension {
                &GeckoExtensionCommand::GetContext => {
                    WebDriverResponse::Generic(resp.to_value_response(true)?)
                }
                &GeckoExtensionCommand::SetContext(_) => WebDriverResponse::Void,
                &GeckoExtensionCommand::XblAnonymousChildren(_) => {
                    let els_vec = try_opt!(
                        resp.result.as_array(),
                        ErrorStatus::UnknownError,
                        "Failed to interpret body as array"
                    );
                    let els = try!(
                        els_vec
                            .iter()
                            .map(|x| self.to_web_element(x))
                            .collect::<Result<Vec<_>, _>>()
                    );
                    WebDriverResponse::Generic(ValueResponse(serde_json::to_value(els)?))
                }
                &GeckoExtensionCommand::XblAnonymousByAttribute(_, _) => {
                    let el = try!(self.to_web_element(try_opt!(
                        resp.result.get("value"),
                        ErrorStatus::UnknownError,
                        "Failed to find value field"
                    )));
                    WebDriverResponse::Generic(ValueResponse(serde_json::to_value(el)?))
                }
                &GeckoExtensionCommand::InstallAddon(_) => {
                    WebDriverResponse::Generic(resp.to_value_response(true)?)
                }
                &GeckoExtensionCommand::UninstallAddon(_) => WebDriverResponse::Void,
            },
        })
    }
}

#[derive(Debug, PartialEq)]
pub struct MarionetteCommand {
    pub id: u64,
    pub name: String,
    pub params: Map<String, Value>,
}

impl Serialize for MarionetteCommand {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let data = (&0, &self.id, &self.name, &self.params);
        data.serialize(serializer)
    }
}

impl MarionetteCommand {
    fn new(id: u64, name: String, params: Map<String, Value>) -> MarionetteCommand {
        MarionetteCommand {
            id: id,
            name: name,
            params: params,
        }
    }

    fn from_webdriver_message(
        id: u64,
        capabilities: Option<Map<String, Value>>,
        msg: &WebDriverMessage<GeckoExtensionRoute>,
    ) -> WebDriverResult<MarionetteCommand> {
        let (opt_name, opt_parameters) = match msg.command {
            Status => panic!("Got status command that should already have been handled"),
            AcceptAlert => {
                // Needs to be updated to "WebDriver:AcceptAlert" for Firefox 63
                (Some("WebDriver:AcceptDialog"), None)
            }
            AddCookie(ref x) => (Some("WebDriver:AddCookie"), Some(x.to_marionette())),
            CloseWindow => (Some("WebDriver:CloseWindow"), None),
            DeleteCookie(ref x) => {
                let mut data = Map::new();
                data.insert("name".to_string(), Value::String(x.clone()));
                (Some("WebDriver:DeleteCookie"), Some(Ok(data)))
            }
            DeleteCookies => (Some("WebDriver:DeleteAllCookies"), None),
            DeleteSession => {
                let mut body = Map::new();
                body.insert(
                    "flags".to_owned(),
                    serde_json::to_value(vec!["eForceQuit".to_string()])?,
                );
                (Some("Marionette:Quit"), Some(Ok(body)))
            }
            DismissAlert => (Some("WebDriver:DismissAlert"), None),
            ElementClear(ref x) => (Some("WebDriver:ElementClear"), Some(x.to_marionette())),
            ElementClick(ref x) => (Some("WebDriver:ElementClick"), Some(x.to_marionette())),
            ElementSendKeys(ref e, ref x) => {
                let mut data = Map::new();
                data.insert("id".to_string(), Value::String(e.id.clone()));
                data.insert("text".to_string(), Value::String(x.text.clone()));
                data.insert(
                    "value".to_string(),
                    serde_json::to_value(
                        x.text
                            .chars()
                            .map(|x| x.to_string())
                            .collect::<Vec<String>>(),
                    )?,
                );
                (Some("WebDriver:ElementSendKeys"), Some(Ok(data)))
            }
            ElementTap(ref x) => (Some("singleTap"), Some(x.to_marionette())),
            ExecuteAsyncScript(ref x) => (
                Some("WebDriver:ExecuteAsyncScript"),
                Some(x.to_marionette()),
            ),
            ExecuteScript(ref x) => (Some("WebDriver:ExecuteScript"), Some(x.to_marionette())),
            FindElement(ref x) => (Some("WebDriver:FindElement"), Some(x.to_marionette())),
            FindElementElement(ref e, ref x) => {
                let mut data = try!(x.to_marionette());
                data.insert("element".to_string(), Value::String(e.id.clone()));
                (Some("WebDriver:FindElement"), Some(Ok(data)))
            }
            FindElements(ref x) => (Some("WebDriver:FindElements"), Some(x.to_marionette())),
            FindElementElements(ref e, ref x) => {
                let mut data = try!(x.to_marionette());
                data.insert("element".to_string(), Value::String(e.id.clone()));
                (Some("WebDriver:FindElements"), Some(Ok(data)))
            }
            FullscreenWindow => (Some("WebDriver:FullscreenWindow"), None),
            Get(ref x) => (Some("WebDriver:Navigate"), Some(x.to_marionette())),
            GetAlertText => (Some("WebDriver:GetAlertText"), None),
            GetActiveElement => (Some("WebDriver:GetActiveElement"), None),
            GetCookies | GetNamedCookie(_) => (Some("WebDriver:GetCookies"), None),
            GetCurrentUrl => (Some("WebDriver:GetCurrentURL"), None),
            GetCSSValue(ref e, ref x) => {
                let mut data = Map::new();
                data.insert("id".to_string(), Value::String(e.id.clone()));
                data.insert("propertyName".to_string(), Value::String(x.clone()));
                (Some("WebDriver:GetElementCSSValue"), Some(Ok(data)))
            }
            GetElementAttribute(ref e, ref x) => {
                let mut data = Map::new();
                data.insert("id".to_string(), Value::String(e.id.clone()));
                data.insert("name".to_string(), Value::String(x.clone()));
                (Some("WebDriver:GetElementAttribute"), Some(Ok(data)))
            }
            GetElementProperty(ref e, ref x) => {
                let mut data = Map::new();
                data.insert("id".to_string(), Value::String(e.id.clone()));
                data.insert("name".to_string(), Value::String(x.clone()));
                (Some("WebDriver:GetElementProperty"), Some(Ok(data)))
            }
            GetElementRect(ref x) => (Some("WebDriver:GetElementRect"), Some(x.to_marionette())),
            GetElementTagName(ref x) => {
                (Some("WebDriver:GetElementTagName"), Some(x.to_marionette()))
            }
            GetElementText(ref x) => (Some("WebDriver:GetElementText"), Some(x.to_marionette())),
            GetPageSource => (Some("WebDriver:GetPageSource"), None),
            GetTimeouts => (Some("WebDriver:GetTimeouts"), None),
            GetTitle => (Some("WebDriver:GetTitle"), None),
            GetWindowHandle => (Some("WebDriver:GetWindowHandle"), None),
            GetWindowHandles => (Some("WebDriver:GetWindowHandles"), None),
            GetWindowRect => (Some("WebDriver:GetWindowRect"), None),
            GoBack => (Some("WebDriver:Back"), None),
            GoForward => (Some("WebDriver:Forward"), None),
            IsDisplayed(ref x) => (
                Some("WebDriver:IsElementDisplayed"),
                Some(x.to_marionette()),
            ),
            IsEnabled(ref x) => (Some("WebDriver:IsElementEnabled"), Some(x.to_marionette())),
            IsSelected(ref x) => (Some("WebDriver:IsElementSelected"), Some(x.to_marionette())),
            MaximizeWindow => (Some("WebDriver:MaximizeWindow"), None),
            MinimizeWindow => (Some("WebDriver:MinimizeWindow"), None),
            NewSession(_) => {
                let caps = capabilities
                    .expect("Tried to create new session without processing capabilities");

                let mut data = Map::new();
                for (k, v) in caps.iter() {
                    data.insert(k.to_string(), serde_json::to_value(v)?);
                }

                (Some("WebDriver:NewSession"), Some(Ok(data)))
            }
            PerformActions(ref x) => (Some("WebDriver:PerformActions"), Some(x.to_marionette())),
            Refresh => (Some("WebDriver:Refresh"), None),
            ReleaseActions => (Some("WebDriver:ReleaseActions"), None),
            SendAlertText(ref x) => {
                let mut data = Map::new();
                data.insert("text".to_string(), Value::String(x.text.clone()));
                data.insert(
                    "value".to_string(),
                    serde_json::to_value(
                        x.text
                            .chars()
                            .map(|x| x.to_string())
                            .collect::<Vec<String>>(),
                    )?,
                );
                (Some("WebDriver:SendAlertText"), Some(Ok(data)))
            }
            SetTimeouts(ref x) => (Some("WebDriver:SetTimeouts"), Some(x.to_marionette())),
            SetWindowRect(ref x) => (Some("WebDriver:SetWindowRect"), Some(x.to_marionette())),
            SwitchToFrame(ref x) => (Some("WebDriver:SwitchToFrame"), Some(x.to_marionette())),
            SwitchToParentFrame => (Some("WebDriver:SwitchToParentFrame"), None),
            SwitchToWindow(ref x) => (Some("WebDriver:SwitchToWindow"), Some(x.to_marionette())),
            TakeElementScreenshot(ref e) => {
                let mut data = Map::new();
                data.insert("element".to_string(), serde_json::to_value(e)?);
                // data.insert("id".to_string(), e.id.to_json());
                data.insert("highlights".to_string(), Value::Array(vec![]));
                data.insert("full".to_string(), Value::Bool(false));
                (Some("WebDriver:TakeScreenshot"), Some(Ok(data)))
            }
            TakeScreenshot => {
                let mut data = Map::new();
                data.insert("id".to_string(), Value::Null);
                data.insert("highlights".to_string(), Value::Array(vec![]));
                data.insert("full".to_string(), Value::Bool(false));
                (Some("WebDriver:TakeScreenshot"), Some(Ok(data)))
            }
            Extension(ref extension) => match extension {
                &GeckoExtensionCommand::GetContext => (Some("Marionette:GetContext"), None),
                &GeckoExtensionCommand::InstallAddon(ref x) => {
                    (Some("Addon:Install"), Some(x.to_marionette()))
                }
                &GeckoExtensionCommand::SetContext(ref x) => {
                    (Some("Marionette:SetContext"), Some(x.to_marionette()))
                }
                &GeckoExtensionCommand::UninstallAddon(ref x) => {
                    (Some("Addon:Uninstall"), Some(x.to_marionette()))
                }
                &GeckoExtensionCommand::XblAnonymousByAttribute(ref e, ref x) => {
                    let mut data = try!(x.to_marionette());
                    data.insert("element".to_string(), Value::String(e.id.clone()));
                    (Some("WebDriver:FindElement"), Some(Ok(data)))
                }
                &GeckoExtensionCommand::XblAnonymousChildren(ref e) => {
                    let mut data = Map::new();
                    data.insert("using".to_owned(), serde_json::to_value("anon")?);
                    data.insert("value".to_owned(), Value::Null);
                    data.insert("element".to_string(), serde_json::to_value(e.id.clone())?);
                    (Some("WebDriver:FindElements"), Some(Ok(data)))
                }
            },
        };

        let name = try_opt!(
            opt_name,
            ErrorStatus::UnsupportedOperation,
            "Operation not supported"
        );
        let parameters = try!(opt_parameters.unwrap_or(Ok(Map::new())));

        Ok(MarionetteCommand::new(id, name.into(), parameters))
    }
}

#[derive(Debug, PartialEq)]
pub struct MarionetteResponse {
    pub id: u64,
    pub error: Option<MarionetteError>,
    pub result: Value,
}

impl<'de> Deserialize<'de> for MarionetteResponse {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct ResponseWrapper {
            msg_type: u64,
            id: u64,
            error: Option<MarionetteError>,
            result: Value,
        }

        let wrapper: ResponseWrapper = Deserialize::deserialize(deserializer)?;

        if wrapper.msg_type != 1 {
            return Err(de::Error::custom(
                "Expected '1' in first element of response",
            ));
        };

        Ok(MarionetteResponse {
            id: wrapper.id,
            error: wrapper.error,
            result: wrapper.result,
        })
    }
}

impl MarionetteResponse {
    fn to_value_response(self, value_required: bool) -> WebDriverResult<ValueResponse> {
        let value: &Value = match value_required {
            true => try_opt!(
                self.result.get("value"),
                ErrorStatus::UnknownError,
                "Failed to find value field"
            ),
            false => &self.result,
        };

        Ok(ValueResponse(value.clone()))
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct MarionetteError {
    #[serde(rename = "error")]
    pub code: String,
    pub message: String,
    pub stacktrace: Option<String>,
}

impl Into<WebDriverError> for MarionetteError {
    fn into(self) -> WebDriverError {
        let status = ErrorStatus::from(self.code);
        let message = self.message;

        if let Some(stack) = self.stacktrace {
            WebDriverError::new_with_stack(status, message, stack)
        } else {
            WebDriverError::new(status, message)
        }
    }
}

fn get_free_port() -> IoResult<u16> {
    TcpListener::bind((DEFAULT_HOST, 0))
        .and_then(|stream| stream.local_addr())
        .map(|x| x.port())
}

pub struct MarionetteConnection {
    port: u16,
    stream: Option<TcpStream>,
    pub session: MarionetteSession,
}

impl MarionetteConnection {
    pub fn new(port: u16, session_id: Option<String>) -> MarionetteConnection {
        MarionetteConnection {
            port: port,
            stream: None,
            session: MarionetteSession::new(session_id),
        }
    }

    pub fn connect(&mut self, browser: &mut Option<FirefoxProcess>) -> WebDriverResult<()> {
        let timeout = time::Duration::from_secs(60);
        let poll_interval = time::Duration::from_millis(100);
        let now = time::Instant::now();

        debug!(
            "Waiting {}s to connect to browser on {}:{}",
            timeout.as_secs(),
            DEFAULT_HOST,
            self.port
        );
        loop {
            // immediately abort connection attempts if process disappears
            if let &mut Some(ref mut runner) = browser {
                let exit_status = match runner.try_wait() {
                    Ok(Some(status)) => Some(
                        status
                            .code()
                            .map(|c| c.to_string())
                            .unwrap_or("signal".into()),
                    ),
                    Ok(None) => None,
                    Err(_) => Some("{unknown}".into()),
                };
                if let Some(s) = exit_status {
                    return Err(WebDriverError::new(
                        ErrorStatus::UnknownError,
                        format!("Process unexpectedly closed with status {}", s),
                    ));
                }
            }

            match TcpStream::connect(&(DEFAULT_HOST, self.port)) {
                Ok(stream) => {
                    self.stream = Some(stream);
                    break;
                }
                Err(e) => {
                    if now.elapsed() < timeout {
                        thread::sleep(poll_interval);
                    } else {
                        return Err(WebDriverError::new(
                            ErrorStatus::UnknownError,
                            e.description().to_owned(),
                        ));
                    }
                }
            }
        }

        let data = self.handshake()?;
        self.session.protocol = Some(data.protocol);
        self.session.application_type = Some(data.application_type);

        debug!("Connected to Marionette on {}:{}", DEFAULT_HOST, self.port);
        Ok(())
    }

    fn handshake(&mut self) -> WebDriverResult<MarionetteHandshake> {
        let resp = self.read_resp()?;
        let data = serde_json::from_str::<MarionetteHandshake>(&resp)?;

        if data.protocol != 3 {
            return Err(WebDriverError::new(
                ErrorStatus::UnknownError,
                format!(
                    "Unsupported Marionette protocol version {}, required 3",
                    data.protocol
                ),
            ));
        }

        Ok(data)
    }

    pub fn close(&self) {}

    fn encode_msg(&self, msg: MarionetteCommand) -> WebDriverResult<String> {
        let data = serde_json::to_string(&msg)?;

        Ok(format!("{}:{}", data.len(), data))
    }

    pub fn send_command(
        &mut self,
        capabilities: Option<Map<String, Value>>,
        msg: &WebDriverMessage<GeckoExtensionRoute>,
    ) -> WebDriverResult<WebDriverResponse> {
        let id = self.session.next_command_id();
        let command = MarionetteCommand::from_webdriver_message(id, capabilities, msg)?;
        let resp_data = self.send(command)?;
        let data: MarionetteResponse = serde_json::from_str(&resp_data)?;

        self.session.response(msg, data)
    }

    fn send(&mut self, msg: MarionetteCommand) -> WebDriverResult<String> {
        let data = self.encode_msg(msg)?;

        match self.stream {
            Some(ref mut stream) => {
                if stream.write(&*data.as_bytes()).is_err() {
                    let mut err = WebDriverError::new(
                        ErrorStatus::UnknownError,
                        "Failed to write response to stream",
                    );
                    err.delete_session = true;
                    return Err(err);
                }
            }
            None => {
                let mut err = WebDriverError::new(
                    ErrorStatus::UnknownError,
                    "Tried to write before opening stream",
                );
                err.delete_session = true;
                return Err(err);
            }
        }

        match self.read_resp() {
            Ok(resp) => Ok(resp),
            Err(_) => {
                let mut err = WebDriverError::new(
                    ErrorStatus::UnknownError,
                    "Failed to decode response from marionette",
                );
                err.delete_session = true;
                Err(err)
            }
        }
    }

    fn read_resp(&mut self) -> IoResult<String> {
        let mut bytes = 0usize;

        // TODO(jgraham): Check before we unwrap?
        let stream = self.stream.as_mut().unwrap();
        loop {
            let buf = &mut [0 as u8];
            let num_read = try!(stream.read(buf));
            let byte = match num_read {
                0 => {
                    return Err(IoError::new(
                        ErrorKind::Other,
                        "EOF reading marionette message",
                    ))
                }
                1 => buf[0] as char,
                _ => panic!("Expected one byte got more"),
            };
            match byte {
                '0'...'9' => {
                    bytes = bytes * 10;
                    bytes += byte as usize - '0' as usize;
                }
                ':' => break,
                _ => {}
            }
        }

        let buf = &mut [0 as u8; 8192];
        let mut payload = Vec::with_capacity(bytes);
        let mut total_read = 0;
        while total_read < bytes {
            let num_read = try!(stream.read(buf));
            if num_read == 0 {
                return Err(IoError::new(
                    ErrorKind::Other,
                    "EOF reading marionette message",
                ));
            }
            total_read += num_read;
            for x in &buf[..num_read] {
                payload.push(*x);
            }
        }

        // TODO(jgraham): Need to handle the error here
        Ok(String::from_utf8(payload).unwrap())
    }
}

trait ToMarionette {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>>;
}

impl ToMarionette for ActionsParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        Ok(try_opt!(
            serde_json::to_value(self)?.as_object(),
            ErrorStatus::UnknownError,
            "Expected an object"
        ).clone())
    }
}

impl ToMarionette for AddCookieParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut cookie = Map::new();
        cookie.insert("name".to_string(), serde_json::to_value(&self.name)?);
        cookie.insert("value".to_string(), serde_json::to_value(&self.value)?);
        if self.path.is_some() {
            cookie.insert("path".to_string(), serde_json::to_value(&self.path)?);
        }
        if self.domain.is_some() {
            cookie.insert("domain".to_string(), serde_json::to_value(&self.domain)?);
        }
        if self.expiry.is_some() {
            cookie.insert("expiry".to_string(), serde_json::to_value(&self.expiry)?);
        }
        cookie.insert("secure".to_string(), serde_json::to_value(self.secure)?);
        cookie.insert("httpOnly".to_string(), serde_json::to_value(self.httpOnly)?);

        let mut data = Map::new();
        data.insert("cookie".to_string(), serde_json::to_value(cookie)?);
        Ok(data)
    }
}

impl ToMarionette for FrameId {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = Map::new();
        match *self {
            FrameId::Short(x) => data.insert("id".to_string(), serde_json::to_value(x)?),
            FrameId::Element(ref x) => data.insert(
                "element".to_string(),
                Value::Object(try!(x.to_marionette())),
            ),
        };
        Ok(data)
    }
}

impl ToMarionette for GetNamedCookieParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        Ok(try_opt!(
            serde_json::to_value(self)?.as_object(),
            ErrorStatus::UnknownError,
            "Expected an object"
        ).clone())
    }
}

impl ToMarionette for GetParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        Ok(try_opt!(
            serde_json::to_value(self)?.as_object(),
            ErrorStatus::UnknownError,
            "Expected an object"
        ).clone())
    }
}

impl ToMarionette for JavascriptCommandParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = serde_json::to_value(self)?.as_object().unwrap().clone();
        data.insert("newSandbox".to_string(), Value::Bool(false));
        data.insert("specialPowers".to_string(), Value::Bool(false));
        data.insert("scriptTimeout".to_string(), Value::Null);
        Ok(data)
    }
}

impl ToMarionette for LocatorParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        Ok(try_opt!(
            serde_json::to_value(self)?.as_object(),
            ErrorStatus::UnknownError,
            "Expected an object"
        ).clone())
    }
}

impl ToMarionette for SwitchToFrameParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = Map::new();
        let key = match self.id {
            None => None,
            Some(FrameId::Short(_)) => Some("id"),
            Some(FrameId::Element(_)) => Some("element"),
        };
        if let Some(x) = key {
            data.insert(x.to_string(), serde_json::to_value(&self.id)?);
        }
        Ok(data)
    }
}

impl ToMarionette for SwitchToWindowParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = Map::new();
        data.insert(
            "name".to_string(),
            serde_json::to_value(self.handle.clone())?,
        );
        Ok(data)
    }
}

impl ToMarionette for TakeScreenshotParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = Map::new();
        let element = match self.element {
            None => Value::Null,
            Some(ref x) => Value::Object(try!(x.to_marionette())),
        };
        data.insert("element".to_string(), element);
        Ok(data)
    }
}

impl ToMarionette for TimeoutsParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        Ok(try_opt!(
            serde_json::to_value(self)?.as_object(),
            ErrorStatus::UnknownError,
            "Expected an object"
        ).clone())
    }
}

impl ToMarionette for WebElement {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        let mut data = Map::new();
        data.insert("id".to_string(), serde_json::to_value(&self.id)?);
        Ok(data)
    }
}

impl ToMarionette for WindowRectParameters {
    fn to_marionette(&self) -> WebDriverResult<Map<String, Value>> {
        Ok(try_opt!(
            serde_json::to_value(self)?.as_object(),
            ErrorStatus::UnknownError,
            "Expected an object"
        ).clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Read;
    use test::check_deserialize;

    #[test]
    fn test_json_addon_install_parameters_null() {
        let json = r#""#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_install_parameters_empty() {
        let json = r#"{}"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_install_parameters_with_path() {
        let json = r#"{"path": "/path/to.xpi", "temporary": true}"#;
        let data = AddonInstallParameters {
            path: "/path/to.xpi".to_string(),
            temporary: true,
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_addon_install_parameters_with_path_invalid_type() {
        let json = r#"{"path": true, "temporary": true}"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_install_parameters_with_path_and_temporary_invalid_type() {
        let json = r#"{"path": "/path/to.xpi", "temporary": "foo"}"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_install_parameters_with_path_only() {
        let json = r#"{"path": "/path/to.xpi"}"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_install_parameters_with_addon() {
        let json = r#"{"addon": "aGVsbG8=", "temporary": true}"#;
        let data = serde_json::from_str::<AddonInstallParameters>(&json).unwrap();

        assert_eq!(data.temporary, true);
        let mut file = File::open(data.path).unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "hello");
    }

    #[test]
    fn test_json_addon_install_parameters_with_addon_invalid_type() {
        let json = r#"{"addon": true, "temporary": true}"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_install_parameters_with_addon_and_temporary_invalid_type() {
        let json = r#"{"addon": "aGVsbG8=", "temporary": "foo"}"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_install_parameters_with_addon_only() {
        let json = r#"{"addon": "aGVsbG8="}"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_install_parameters_with_temporary_only() {
        let json = r#"{"temporary": true}"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_install_parameters_with_both_path_and_addon() {
        let json = r#"{
            "path":"/path/to.xpi",
            "addon":"aGVsbG8=",
            "temporary":true
        }"#;

        assert!(serde_json::from_str::<AddonInstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_uninstall_parameters_null() {
        let json = r#""#;

        assert!(serde_json::from_str::<AddonUninstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_uninstall_parameters_empty() {
        let json = r#"{}"#;

        assert!(serde_json::from_str::<AddonUninstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_addon_uninstall_parameters() {
        let json = r#"{"id": "foo"}"#;
        let data = AddonUninstallParameters {
            id: "foo".to_string(),
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_addon_uninstall_parameters_id_invalid_type() {
        let json = r#"{"id": true}"#;

        assert!(serde_json::from_str::<AddonUninstallParameters>(&json).is_err());
    }

    #[test]
    fn test_json_gecko_context_parameters_content() {
        let json = r#"{"context": "content"}"#;
        let data = GeckoContextParameters {
            context: GeckoContext::Content,
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_gecko_context_parameters_chrome() {
        let json = r#"{"context": "chrome"}"#;
        let data = GeckoContextParameters {
            context: GeckoContext::Chrome,
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_gecko_context_parameters_context_missing() {
        let json = r#"{}"#;

        assert!(serde_json::from_str::<GeckoContextParameters>(&json).is_err());
    }

    #[test]
    fn test_json_gecko_context_parameters_context_null() {
        let json = r#"{"context": null}"#;

        assert!(serde_json::from_str::<GeckoContextParameters>(&json).is_err());
    }

    #[test]
    fn test_json_gecko_context_parameters_context_invalid_value() {
        let json = r#"{"context": "foo"}"#;

        assert!(serde_json::from_str::<GeckoContextParameters>(&json).is_err());
    }

    #[test]
    fn test_json_xbl_anonymous_by_attribute() {
        let json = r#"{
            "name": "foo",
            "value": "bar"
        }"#;

        let data = XblLocatorParameters {
            name: "foo".to_string(),
            value: "bar".to_string(),
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_xbl_anonymous_by_attribute_with_name_missing() {
        let json = r#"{
            "value": "bar"
        }"#;

        assert!(serde_json::from_str::<XblLocatorParameters>(&json).is_err());
    }

    #[test]
    fn test_json_xbl_anonymous_by_attribute_with_name_invalid_type() {
        let json = r#"{
            "name": null,
            "value": "bar"
        }"#;

        assert!(serde_json::from_str::<XblLocatorParameters>(&json).is_err());
    }

    #[test]
    fn test_json_xbl_anonymous_by_attribute_with_value_missing() {
        let json = r#"{
            "name": "foo",
        }"#;

        assert!(serde_json::from_str::<XblLocatorParameters>(&json).is_err());
    }

    #[test]
    fn test_json_xbl_anonymous_by_attribute_with_value_invalid_type() {
        let json = r#"{
            "name": "foo",
            "value": null
        }"#;

        assert!(serde_json::from_str::<XblLocatorParameters>(&json).is_err());
    }
}
