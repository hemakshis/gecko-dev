use common::MAX_SAFE_INTEGER;
use error::{ErrorStatus, WebDriverError, WebDriverResult};
use serde_json::{Map, Value};
use std::convert::From;
use url::Url;

pub type Capabilities = Map<String, Value>;

/// Trait for objects that can be used to inspect browser capabilities
///
/// The main methods in this trait are called with a Capabilites object
/// resulting from a full set of potential capabilites for the session.  Given
/// those Capabilities they return a property of the browser instance that
/// would be initiated. In many cases this will be independent of the input,
/// but in the case of e.g. browser version, it might depend on a path to the
/// binary provided as a capability.
pub trait BrowserCapabilities {
    /// Set up the Capabilites object
    ///
    /// Typically used to create any internal caches
    fn init(&mut self, &Capabilities);

    /// Name of the browser
    fn browser_name(&mut self, &Capabilities) -> WebDriverResult<Option<String>>;

    /// Version number of the browser
    fn browser_version(&mut self, &Capabilities) -> WebDriverResult<Option<String>>;

    /// Compare actual browser version to that provided in a version specifier
    ///
    /// Parameters are the actual browser version and the comparison string,
    /// respectively. The format of the comparison string is
    /// implementation-defined.
    fn compare_browser_version(&mut self, version: &str, comparison: &str)
        -> WebDriverResult<bool>;

    /// Name of the platform/OS
    fn platform_name(&mut self, &Capabilities) -> WebDriverResult<Option<String>>;

    /// Whether insecure certificates are supported
    fn accept_insecure_certs(&mut self, &Capabilities) -> WebDriverResult<bool>;

    /// Indicates whether driver supports all of the window resizing and
    /// repositioning commands.
    fn set_window_rect(&mut self, &Capabilities) -> WebDriverResult<bool>;

    fn accept_proxy(
        &mut self,
        proxy_settings: &Map<String, Value>,
        &Capabilities,
    ) -> WebDriverResult<bool>;

    /// Type check custom properties
    ///
    /// Check that custom properties containing ":" have the correct data types.
    /// Properties that are unrecognised must be ignored i.e. return without
    /// error.
    fn validate_custom(&self, name: &str, value: &Value) -> WebDriverResult<()>;

    /// Check if custom properties are accepted capabilites
    ///
    /// Check that custom properties containing ":" are compatible with
    /// the implementation.
    fn accept_custom(
        &mut self,
        name: &str,
        value: &Value,
        merged: &Capabilities,
    ) -> WebDriverResult<bool>;
}

/// Trait to abstract over various version of the new session parameters
///
/// This trait is expected to be implemented on objects holding the capabilities
/// from a new session command.
pub trait CapabilitiesMatching {
    /// Match the BrowserCapabilities against some candidate capabilites
    ///
    /// Takes a BrowserCapabilites object and returns a set of capabilites that
    /// are valid for that browser, if any, or None if there are no matching
    /// capabilities.
    fn match_browser<T: BrowserCapabilities>(
        &self,
        browser_capabilities: &mut T,
    ) -> WebDriverResult<Option<Capabilities>>;
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct SpecNewSessionParameters {
    #[serde(default = "Capabilities::default")]
    pub alwaysMatch: Capabilities,
    #[serde(default = "firstMatch_default")]
    pub firstMatch: Vec<Capabilities>,
}

impl Default for SpecNewSessionParameters {
    fn default() -> Self {
        SpecNewSessionParameters {
            alwaysMatch: Capabilities::new(),
            firstMatch: vec![Capabilities::new()],
        }
    }
}

fn firstMatch_default() -> Vec<Capabilities> {
    vec![Capabilities::default()]
}

impl SpecNewSessionParameters {
    fn validate<T: BrowserCapabilities>(
        &self,
        mut capabilities: Capabilities,
        browser_capabilities: &T,
    ) -> WebDriverResult<Capabilities> {
        // Filter out entries with the value `null`
        let null_entries = capabilities
            .iter()
            .filter(|&(_, ref value)| **value == Value::Null)
            .map(|(k, _)| k.clone())
            .collect::<Vec<String>>();
        for key in null_entries {
            capabilities.remove(&key);
        }

        for (key, value) in capabilities.iter() {
            match &**key {
                x @ "acceptInsecureCerts" | x @ "setWindowRect" => if !value.is_boolean() {
                    return Err(WebDriverError::new(
                        ErrorStatus::InvalidArgument,
                        format!("{} is not boolean: {}", x, value),
                    ));
                },
                x @ "browserName" | x @ "browserVersion" | x @ "platformName" => {
                    if !value.is_string() {
                        return Err(WebDriverError::new(
                            ErrorStatus::InvalidArgument,
                            format!("{} is not a string: {}", x, value),
                        ));
                    }
                }
                "pageLoadStrategy" => SpecNewSessionParameters::validate_page_load_strategy(value)?,
                "proxy" => SpecNewSessionParameters::validate_proxy(value)?,
                "timeouts" => SpecNewSessionParameters::validate_timeouts(value)?,
                "unhandledPromptBehavior" => {
                    SpecNewSessionParameters::validate_unhandled_prompt_behaviour(value)?
                }
                x => {
                    if !x.contains(":") {
                        return Err(WebDriverError::new(
                            ErrorStatus::InvalidArgument,
                            format!(
                                "{} is not the name of a known capability or extension capability",
                                x
                            ),
                        ));
                    } else {
                        browser_capabilities.validate_custom(x, value)?
                    }
                }
            }
        }
        Ok(capabilities)
    }

    fn validate_page_load_strategy(value: &Value) -> WebDriverResult<()> {
        match value {
            &Value::String(ref x) => match &**x {
                "normal" | "eager" | "none" => {}
                x => {
                    return Err(WebDriverError::new(
                        ErrorStatus::InvalidArgument,
                        format!("Invalid page load strategy: {}", x),
                    ))
                }
            },
            _ => {
                return Err(WebDriverError::new(
                    ErrorStatus::InvalidArgument,
                    "pageLoadStrategy is not a string",
                ))
            }
        }
        Ok(())
    }

    fn validate_proxy(proxy_value: &Value) -> WebDriverResult<()> {
        let obj = try_opt!(
            proxy_value.as_object(),
            ErrorStatus::InvalidArgument,
            "proxy is not an object"
        );

        for (key, value) in obj.iter() {
            match &**key {
                "proxyType" => match value.as_str() {
                    Some("pac") | Some("direct") | Some("autodetect") | Some("system")
                    | Some("manual") => {}
                    Some(x) => {
                        return Err(WebDriverError::new(
                            ErrorStatus::InvalidArgument,
                            format!("Invalid proxyType value: {}", x),
                        ))
                    }
                    None => {
                        return Err(WebDriverError::new(
                            ErrorStatus::InvalidArgument,
                            format!("proxyType is not a string: {}", value),
                        ))
                    }
                },

                "proxyAutoconfigUrl" => match value.as_str() {
                    Some(x) => {
                        Url::parse(x).or(Err(WebDriverError::new(
                            ErrorStatus::InvalidArgument,
                            format!("proxyAutoconfigUrl is not a valid URL: {}", x),
                        )))?;
                    }
                    None => {
                        return Err(WebDriverError::new(
                            ErrorStatus::InvalidArgument,
                            "proxyAutoconfigUrl is not a string",
                        ))
                    }
                },

                "ftpProxy" => SpecNewSessionParameters::validate_host(value, "ftpProxy")?,
                "httpProxy" => SpecNewSessionParameters::validate_host(value, "httpProxy")?,
                "noProxy" => SpecNewSessionParameters::validate_no_proxy(value)?,
                "sslProxy" => SpecNewSessionParameters::validate_host(value, "sslProxy")?,
                "socksProxy" => SpecNewSessionParameters::validate_host(value, "socksProxy")?,
                "socksVersion" => if !value.is_number() {
                    return Err(WebDriverError::new(
                        ErrorStatus::InvalidArgument,
                        format!("socksVersion is not a number: {}", value),
                    ));
                },

                x => {
                    return Err(WebDriverError::new(
                        ErrorStatus::InvalidArgument,
                        format!("Invalid proxy configuration entry: {}", x),
                    ))
                }
            }
        }

        Ok(())
    }

    fn validate_no_proxy(value: &Value) -> WebDriverResult<()> {
        match value.as_array() {
            Some(hosts) => {
                for host in hosts {
                    match host.as_str() {
                        Some(_) => {}
                        None => {
                            return Err(WebDriverError::new(
                                ErrorStatus::InvalidArgument,
                                format!("noProxy item is not a string: {}", host),
                            ))
                        }
                    }
                }
            }
            None => {
                return Err(WebDriverError::new(
                    ErrorStatus::InvalidArgument,
                    format!("noProxy is not an array: {}", value),
                ))
            }
        }

        Ok(())
    }

    /// Validate whether a named capability is JSON value is a string containing a host
    /// and possible port
    fn validate_host(value: &Value, entry: &str) -> WebDriverResult<()> {
        match value.as_str() {
            Some(host) => {
                if host.contains("://") {
                    return Err(WebDriverError::new(
                        ErrorStatus::InvalidArgument,
                        format!("{} must not contain a scheme: {}", entry, host),
                    ));
                }

                // Temporarily add a scheme so the host can be parsed as URL
                let s = String::from(format!("http://{}", host));
                let url = Url::parse(s.as_str()).or(Err(WebDriverError::new(
                    ErrorStatus::InvalidArgument,
                    format!("{} is not a valid URL: {}", entry, host),
                )))?;

                if url.username() != "" || url.password() != None || url.path() != "/"
                    || url.query() != None || url.fragment() != None
                {
                    return Err(WebDriverError::new(
                        ErrorStatus::InvalidArgument,
                        format!("{} is not of the form host[:port]: {}", entry, host),
                    ));
                }
            }

            None => {
                return Err(WebDriverError::new(
                    ErrorStatus::InvalidArgument,
                    format!("{} is not a string: {}", entry, value),
                ))
            }
        }

        Ok(())
    }

    fn validate_timeouts(value: &Value) -> WebDriverResult<()> {
        let obj = try_opt!(
            value.as_object(),
            ErrorStatus::InvalidArgument,
            "timeouts capability is not an object"
        );

        for (key, value) in obj.iter() {
            match &**key {
                x @ "script" | x @ "pageLoad" | x @ "implicit" => {
                    let timeout = try_opt!(
                        value.as_f64(),
                        ErrorStatus::InvalidArgument,
                        format!("{} timeouts value is not a number: {}", x, value)
                    );
                    if timeout < 0.0 || timeout.fract() != 0.0 {
                        return Err(WebDriverError::new(
                            ErrorStatus::InvalidArgument,
                            format!(
                                "'{}' timeouts value is not a positive Integer: {}",
                                x, timeout
                            ),
                        ));
                    }
                    if (timeout as u64) > MAX_SAFE_INTEGER {
                        return Err(WebDriverError::new(
                            ErrorStatus::InvalidArgument,
                            format!(
                                "'{}' timeouts value is greater than maximum safe integer: {}",
                                x, timeout
                            ),
                        ));
                    }
                }

                x => {
                    return Err(WebDriverError::new(
                        ErrorStatus::InvalidArgument,
                        format!("Invalid timeouts capability entry: {}", x),
                    ))
                }
            }
        }

        Ok(())
    }

    fn validate_unhandled_prompt_behaviour(value: &Value) -> WebDriverResult<()> {
        let behaviour = try_opt!(
            value.as_str(),
            ErrorStatus::InvalidArgument,
            format!("unhandledPromptBehavior is not a string: {}", value)
        );

        match behaviour {
            "accept" | "accept and notify" | "dismiss" | "dismiss and notify" | "ignore" => {}
            x => {
                return Err(WebDriverError::new(
                    ErrorStatus::InvalidArgument,
                    format!("Invalid unhandledPromptBehavior value: {}", x),
                ))
            }
        }

        Ok(())
    }
}

impl CapabilitiesMatching for SpecNewSessionParameters {
    fn match_browser<T: BrowserCapabilities>(
        &self,
        browser_capabilities: &mut T,
    ) -> WebDriverResult<Option<Capabilities>> {
        let default = vec![Map::new()];
        let capabilities_list = if self.firstMatch.len() > 0 {
            &self.firstMatch
        } else {
            &default
        };

        let merged_capabilities = capabilities_list
            .iter()
            .map(|first_match_entry| {
                if first_match_entry
                    .keys()
                    .any(|k| self.alwaysMatch.contains_key(k))
                {
                    return Err(WebDriverError::new(
                        ErrorStatus::InvalidArgument,
                        "firstMatch key shadowed a value in alwaysMatch",
                    ));
                }
                let mut merged = self.alwaysMatch.clone();
                for (key, value) in first_match_entry.clone().into_iter() {
                    merged.insert(key, value);
                }
                Ok(merged)
            })
            .map(|merged| merged.and_then(|x| self.validate(x, browser_capabilities)))
            .collect::<WebDriverResult<Vec<Capabilities>>>()?;

        let selected = merged_capabilities
            .iter()
            .filter_map(|merged| {
                browser_capabilities.init(merged);

                for (key, value) in merged.iter() {
                    match &**key {
                        "browserName" => {
                            let browserValue = browser_capabilities
                                .browser_name(merged)
                                .ok()
                                .and_then(|x| x);

                            if value.as_str() != browserValue.as_ref().map(|x| &**x) {
                                return None;
                            }
                        }
                        "browserVersion" => {
                            let browserValue = browser_capabilities
                                .browser_version(merged)
                                .ok()
                                .and_then(|x| x);
                            // We already validated this was a string
                            let version_cond = value.as_str().unwrap_or("");
                            if let Some(version) = browserValue {
                                if !browser_capabilities
                                    .compare_browser_version(&*version, version_cond)
                                    .unwrap_or(false)
                                {
                                    return None;
                                }
                            } else {
                                return None;
                            }
                        }
                        "platformName" => {
                            let browserValue = browser_capabilities
                                .platform_name(merged)
                                .ok()
                                .and_then(|x| x);
                            if value.as_str() != browserValue.as_ref().map(|x| &**x) {
                                return None;
                            }
                        }
                        "acceptInsecureCerts" => {
                            if value.as_bool().unwrap_or(false)
                                && !browser_capabilities
                                    .accept_insecure_certs(merged)
                                    .unwrap_or(false)
                            {
                                return None;
                            }
                        }
                        "setWindowRect" => {
                            if value.as_bool().unwrap_or(false)
                                && !browser_capabilities
                                    .set_window_rect(merged)
                                    .unwrap_or(false)
                            {
                                return None;
                            }
                        }
                        "proxy" => {
                            let default = Map::new();
                            let proxy = value.as_object().unwrap_or(&default);
                            if !browser_capabilities
                                .accept_proxy(&proxy, merged)
                                .unwrap_or(false)
                            {
                                return None;
                            }
                        }
                        name => {
                            if name.contains(":") {
                                if !browser_capabilities
                                    .accept_custom(name, value, merged)
                                    .unwrap_or(false)
                                {
                                    return None;
                                }
                            } else {
                                // Accept the capability
                            }
                        }
                    }
                }

                return Some(merged);
            })
            .next()
            .map(|x| x.clone());
        Ok(selected)
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct LegacyNewSessionParameters {
    #[serde(default = "Capabilities::default")]
    pub desired: Capabilities,
    #[serde(default = "Capabilities::default")]
    pub required: Capabilities,
}

impl CapabilitiesMatching for LegacyNewSessionParameters {
    fn match_browser<T: BrowserCapabilities>(
        &self,
        browser_capabilities: &mut T,
    ) -> WebDriverResult<Option<Capabilities>> {
        // For now don't do anything much, just merge the
        // desired and required and return the merged list.

        let mut capabilities: Capabilities = Map::new();
        self.required.iter().chain(self.desired.iter()).fold(
            &mut capabilities,
            |caps, (key, value)| {
                if !caps.contains_key(key) {
                    caps.insert(key.clone(), value.clone());
                }
                caps
            },
        );
        browser_capabilities.init(&capabilities);
        Ok(Some(capabilities))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{self, Value};
    use test::check_deserialize;

    fn validate_proxy(value: &str) -> WebDriverResult<()> {
        let data = serde_json::from_str::<Value>(value).unwrap();
        SpecNewSessionParameters::validate_proxy(&data)
    }

    #[test]
    fn test_json_spec_new_session_parameters_alwaysMatch_only() {
        let json = r#"{
            "alwaysMatch":{}
        }"#;
        let data = SpecNewSessionParameters {
            alwaysMatch: Capabilities::new(),
            firstMatch: vec![Capabilities::new()],
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_spec_new_session_parameters_firstMatch_only() {
        let json = r#"{
            "firstMatch":[{}]
        }"#;
        let data = SpecNewSessionParameters {
            alwaysMatch: Capabilities::new(),
            firstMatch: vec![Capabilities::new()],
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_spec_new_session_parameters_alwaysMatch_null() {
        let json = r#"{
            "alwaysMatch":null,
            "firstMatch":[{}]
        }"#;

        assert!(serde_json::from_str::<SpecNewSessionParameters>(&json).is_err());
    }

    #[test]
    fn test_json_spec_new_session_parameters_firstMatch_null() {
        let json = r#"{
            "alwaysMatch":{},
            "firstMatch":null
        }"#;

        assert!(serde_json::from_str::<SpecNewSessionParameters>(&json).is_err());
    }

    #[test]
    fn test_json_spec_new_session_parameters_both_empty() {
        let json = r#"{
            "alwaysMatch":{},
            "firstMatch":[{}]
        }"#;
        let data = SpecNewSessionParameters {
            alwaysMatch: Capabilities::new(),
            firstMatch: vec![Capabilities::new()],
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_spec_new_session_parameters_both_with_capability() {
        let json = r#"{
            "alwaysMatch":{"foo":"bar"},
            "firstMatch":[{"foo2":"bar2"}]
        }"#;
        let mut data = SpecNewSessionParameters {
            alwaysMatch: Capabilities::new(),
            firstMatch: vec![Capabilities::new()],
        };
        data.alwaysMatch.insert("foo".into(), "bar".into());
        data.firstMatch[0].insert("foo2".into(), "bar2".into());

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_spec_legacy_new_session_parameters_desired_only() {
        let json = r#"{"desired":{}}"#;
        let data = LegacyNewSessionParameters {
            desired: Capabilities::new(),
            required: Capabilities::new(),
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_spec_legacy_new_session_parameters_required_only() {
        let json = r#"{"required":{}}"#;
        let data = LegacyNewSessionParameters {
            desired: Capabilities::new(),
            required: Capabilities::new(),
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_spec_legacy_new_session_parameters_desired_null() {
        let json = r#"{"desired":null,"required":{}}"#;

        assert!(serde_json::from_str::<LegacyNewSessionParameters>(&json).is_err());
    }

    #[test]
    fn test_json_spec_legacy_new_session_parameters_required_null() {
        let json = r#"{"desired":{}, "required":null}"#;

        assert!(serde_json::from_str::<LegacyNewSessionParameters>(&json).is_err());
    }

    #[test]
    fn test_json_spec_legacy_new_session_parameters_both_empty() {
        let json = r#"{"desired":{},"required":{}}"#;
        let data = LegacyNewSessionParameters {
            desired: Capabilities::new(),
            required: Capabilities::new(),
        };

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_json_spec_legacy_new_session_parameters_both_with_capabilities() {
        let json = r#"{"desired":{"foo":"bar"},"required":{"foo2":"bar2"}}"#;
        let mut data = LegacyNewSessionParameters {
            desired: Capabilities::new(),
            required: Capabilities::new(),
        };
        data.desired.insert("foo".into(), "bar".into());
        data.required.insert("foo2".into(), "bar2".into());

        check_deserialize(&json, &data);
    }

    #[test]
    fn test_validate_proxy() {
        // proxy hosts
        validate_proxy("{\"httpProxy\": \"127.0.0.1\"}").unwrap();
        validate_proxy("{\"httpProxy\": \"127.0.0.1:\"}").unwrap();
        validate_proxy("{\"httpProxy\": \"127.0.0.1:3128\"}").unwrap();
        validate_proxy("{\"httpProxy\": \"localhost\"}").unwrap();
        validate_proxy("{\"httpProxy\": \"localhost:3128\"}").unwrap();
        validate_proxy("{\"httpProxy\": \"[2001:db8::1]\"}").unwrap();
        validate_proxy("{\"httpProxy\": \"[2001:db8::1]:3128\"}").unwrap();
        validate_proxy("{\"httpProxy\": \"example.org\"}").unwrap();
        validate_proxy("{\"httpProxy\": \"example.org:3128\"}").unwrap();

        assert!(validate_proxy("{\"httpProxy\": \"http://example.org\"}").is_err());
        assert!(validate_proxy("{\"httpProxy\": \"example.org:-1\"}").is_err());
        assert!(validate_proxy("{\"httpProxy\": \"2001:db8::1\"}").is_err());

        // no proxy for manual proxy type
        validate_proxy("{\"noProxy\": [\"foo\"]}").unwrap();

        assert!(validate_proxy("{\"noProxy\": \"foo\"}").is_err());
        assert!(validate_proxy("{\"noProxy\": [42]}").is_err());
    }
}
