/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  schema: "resource:///modules/policies/schema.jsm",
});

function col(text, className) {
  let column = document.createElement("td");
  if (className) {
    column.classList.add(className);
  }
  let content = document.createTextNode(text);
  column.appendChild(content);
  return column;
}

function machine_only_col(text) {
  let icon = document.createElement("span");
  icon.classList.add("icon");
  icon.classList.add("machine-only");
  icon.title = "Machine-only";
  let column = document.createElement("td");
  let content = document.createTextNode(text);
  column.appendChild(content);
  column.appendChild(icon);
  return column;
}

/*
 * This function generates the Active Policies content to be displayed by calling
 * a recursive function called generatePolicy() according to the policy schema.
 */

function generateActivePolicies(data) {

  let new_cont = document.getElementById("activeContent");
  new_cont.classList.add("active-policies");

  for (let policyName in data) {
    if (schema.properties[policyName].type == "array") {
      for (let count in data[policyName]) {
        let isFirstRow = (count == 0);
        let isLastRow = (count == data[policyName].length - 1);
        let row = document.createElement("tr");
        row.appendChild(col(isFirstRow ? policyName : ""));
        generatePolicy(data[policyName][count], row, 1, new_cont, isLastRow, !isFirstRow);
      }
    } else if (schema.properties[policyName].type == "object") {
      let count = 0;
      for (let obj in data[policyName]) {
        let isFirstRow = (count == 0);
        let isLastRow = (count == data[policyName].length - 1);
        let row = document.createElement("tr");
        row.appendChild(col(isFirstRow ? policyName : ""));
        row.appendChild(col(obj));
        generatePolicy(data[policyName][obj], row, 2, new_cont, isLastRow);
        count++;
      }
    } else {
      let row = document.createElement("tr");
      row.appendChild(col(policyName));
      row.appendChild(col(JSON.stringify(data[policyName])));
      row.classList.add("lastpolicyrow");
      new_cont.appendChild(row);
    }
  }
}

/*
 * This is a helper recursive function that iterates levels of each
 * policy and formats the content to be displayed accordingly.
 */

function generatePolicy(data, row, depth, new_cont, islast, arr_sep = false) {
  if (Array.isArray(data)) {
    for (let count in data) {
      if (count == 0) {
        if (count == data.length - 1) {
          generatePolicy(data[count], row, depth + 1, new_cont, islast ? islast : false, false);
        } else {
          generatePolicy(data[count], row, depth + 1, new_cont, false, true);
        }
      } else if (count == data.length - 1) {
        let last_row = document.createElement("tr");
        for (let i = 0; i < depth; i++) {
            last_row.appendChild(col(""));
        }

        generatePolicy(data[count], last_row, depth + 1, new_cont, islast ? islast : false, arr_sep);
      } else {
        let new_row = document.createElement("tr");
        for (let i = 0; i < depth; i++) {
          new_row.appendChild(col(""));
        }

        generatePolicy(data[count], new_row, depth + 1, new_cont, false, true);
      }
    }
  } else if (typeof data == "object" && Object.keys(data).length > 0) {
    let count = 0;
      for (let obj in data) {
        if (count == 0) {
          row.appendChild(col(obj));
          if (count == Object.keys(data).length - 1) {
            generatePolicy(data[obj], row, depth + 1, new_cont, islast ? islast : false, arr_sep);
          } else {
            generatePolicy(data[obj], row, depth + 1, new_cont, false, false);
          }
        } else if (count == Object.keys(data).length - 1) {
          let last_row = document.createElement("tr");
          for (let i = 0; i < depth; i++) {
            last_row.appendChild(col(""));
          }

          if (arr_sep) {
            last_row.appendChild(col(obj, "array"));
          } else {
            last_row.appendChild(col(obj));
          }

          generatePolicy(data[obj], last_row, depth + 1, new_cont, islast ? islast : false, arr_sep);
        } else {
          let new_row = document.createElement("tr");
          for (let i = 0; i < depth; i++) {
            new_row.appendChild(col(""));
          }

          new_row.appendChild(col(obj));
          generatePolicy(data[obj], new_row, depth + 1, new_cont, false, false);
        }
        count++;
      }
  } else {
    if (arr_sep) {
      row.appendChild(col(JSON.stringify(data), "array"));
    } else {
      row.appendChild(col(JSON.stringify(data)));
    }
    if (islast) {
      row.classList.add("lastpolicyrow");
    }
    new_cont.appendChild(row);
  }
}

function generateErrors() {
  const consoleStorage = Cc["@mozilla.org/consoleAPI-storage;1"];
  const storage = consoleStorage.getService(Ci.nsIConsoleAPIStorage);
  const consoleEvents = storage.getEvents();
  const prefixes = ["Enterprise Policies",
                    "JsonSchemaValidator.jsm",
                    "Policies.jsm",
                    "GPOParser.jsm",
                    "Enterprise Policies Child",
                    "BookmarksPolicies.jsm",
                    "ProxyPolicies.jsm",
                    "WebsiteFilter Policy"];

  let new_cont = document.getElementById("errorsContent");
  new_cont.classList.add("errors");

  let flag = false;
  for (let err of consoleEvents) {
    if (prefixes.includes(err.prefix)) {
      flag = true;
      let row = document.createElement("tr");
      row.appendChild(col(err.arguments[0], "schema"));
      new_cont.appendChild(row);
    }
  }

  if (!flag) {
    let errors_tab = document.getElementById("category-errors");
    errors_tab.style.display = "none";
  }
}

function generateDocumentation() {
  let new_cont = document.getElementById("documentationContent");
  new_cont.setAttribute("id", "documentationContent");

  for (let policyName in schema.properties) {
    let main_tbody = document.createElement("tbody");
    main_tbody.classList.add("collapsible");
    main_tbody.addEventListener("click", function() {
      let content = this.nextElementSibling;
      content.classList.toggle("content");
    });
    let row = document.createElement("tr");
    if (schema.properties[policyName].machine_only) {
      row.appendChild(machine_only_col(policyName));
    } else {
      row.appendChild(col(policyName));
    }
    row.appendChild(col(schema.properties[policyName].description));
    main_tbody.appendChild(row);
    let sec_tbody = document.createElement("tbody");
    sec_tbody.classList.add("content");
    sec_tbody.classList.add("content-style");
    let schema_row = document.createElement("tr");
    if (schema.properties[policyName].properties) {
      let column = col(JSON.stringify(schema.properties[policyName].properties, null, 1), "schema");
      column.colSpan = "2";
      schema_row.appendChild(column);
      sec_tbody.appendChild(schema_row);
    } else {
      let column = col("type: " + schema.properties[policyName].type, "schema");
      column.colSpan = "2";
      schema_row.appendChild(column);
      sec_tbody.appendChild(schema_row);
      if (schema.properties[policyName].enum) {
        let enum_row = document.createElement("tr");
        column = col("enum: " + JSON.stringify(schema.properties[policyName].enum, null, 1), "schema");
        column.colSpan = "2";
        enum_row.appendChild(column);
        sec_tbody.appendChild(enum_row);
      }
    }
    new_cont.appendChild(main_tbody);
    new_cont.appendChild(sec_tbody);
  }
}

let gInited = false;
function init() {
  if (gInited) {
    return;
  }
  gInited = true;

  let data = Services.policies.getActivePolicies();
  generateActivePolicies(data);
  generateErrors();
  generateDocumentation();

  // Event delegation on #categories element
  let menu = document.getElementById("categories");
  menu.addEventListener("click", function click(e) {
    if (e.target && e.target.parentNode == menu)
      show(e.target);
  });

  if (location.hash) {
    let sectionButton = document.getElementById("category-" + location.hash.substring(1));
    if (sectionButton) {
      sectionButton.click();
    }
  }
}

function show(button) {
  let current_tab = document.querySelector(".active");
  let category = button.getAttribute("id").substring("category-".length);
  let content = document.getElementById(category);
  if (current_tab == content)
    return;
  current_tab.classList.remove("active");
  current_tab.hidden = true;
  content.classList.add("active");
  content.hidden = false;

  let current_button = document.querySelector("[selected=true]");
  current_button.removeAttribute("selected");
  button.setAttribute("selected", "true");

  let title = document.getElementById("sectionTitle");
  title.textContent = button.children[0].textContent;
  location.hash = category;
}
