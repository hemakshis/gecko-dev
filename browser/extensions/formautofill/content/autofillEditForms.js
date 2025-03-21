/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* exported EditAddress, EditCreditCard */
/* eslint-disable mozilla/balanced-listeners */ // Not relevant since the document gets unloaded.

"use strict";

class EditAutofillForm {
  constructor(elements) {
    this._elements = elements;
  }

  /**
   * Fill the form with a record object.
   * @param  {object} [record = {}]
   */
  loadRecord(record = {}) {
    for (let field of this._elements.form.elements) {
      let value = record[field.id];
      value = typeof(value) == "undefined" ? "" : value;

      if (record.guid) {
        field.value = value;
      } else if (field.localName == "select") {
        this.setDefaultSelectedOptionByValue(field, value);
      } else {
        // Use .defaultValue instead of .value to avoid setting the `dirty` flag
        // which triggers form validation UI.
        field.defaultValue = value;
      }
    }
    if (!record.guid) {
      // Reset the dirty value flag and validity state.
      this._elements.form.reset();
    }

    for (let field of this._elements.form.elements) {
      this.updatePopulatedState(field);
    }
  }

  setDefaultSelectedOptionByValue(select, value) {
    for (let option of select.options) {
      option.defaultSelected = option.value == value;
    }
  }

  /**
   * Get inputs from the form.
   * @returns {object}
   */
  buildFormObject() {
    return Array.from(this._elements.form.elements).reduce((obj, input) => {
      if (!input.disabled) {
        obj[input.id] = input.value;
      }
      return obj;
    }, {});
  }

  /**
   * Handle events
   *
   * @param  {DOMEvent} event
   */
  handleEvent(event) {
    switch (event.type) {
      case "change": {
        this.handleChange(event);
        break;
      }
      case "input": {
        this.handleInput(event);
        break;
      }
    }
  }

  /**
   * Handle change events
   *
   * @param  {DOMEvent} event
   */
  handleChange(event) {
    this.updatePopulatedState(event.target);
  }

  /**
   * Handle input events
   *
   * @param  {DOMEvent} event
   */
  handleInput(event) {}

  /**
   * Attach event listener
   */
  attachEventListeners() {
    this._elements.form.addEventListener("input", this);
  }

  /**
   * Set the field-populated attribute if the field has a value.
   *
   * @param {DOMElement} field The field that will be checked for a value.
   */
  updatePopulatedState(field) {
    let span = field.parentNode.querySelector(".label-text");
    if (!span) {
      return;
    }
    span.toggleAttribute("field-populated", !!field.value.trim());
  }
}

class EditAddress extends EditAutofillForm {
  /**
   * @param {HTMLElement[]} elements
   * @param {object} record
   * @param {object} config
   * @param {string[]} config.DEFAULT_REGION
   * @param {function} config.getFormFormat Function to return form layout info for a given country.
   * @param {string[]} config.supportedCountries
   */
  constructor(elements, record, config) {
    super(elements);

    Object.assign(this, config);
    Object.assign(this._elements, {
      addressLevel1Label: this._elements.form.querySelector("#address-level1-container > span"),
      postalCodeLabel: this._elements.form.querySelector("#postal-code-container > span"),
      country: this._elements.form.querySelector("#country"),
    });

    this.populateCountries();
    // Need to populate the countries before trying to set the initial country.
    // Also need to use this._record so it has the default country selected.
    this.loadRecord(record);
    this.attachEventListeners();

    if (config.novalidate) {
      this.form.setAttribute("novalidate", "true");
    }
  }

  loadRecord(record) {
    this._record = record;
    if (!record) {
      record = {
        country: this.supportedCountries.find(supported => supported == this.DEFAULT_REGION),
      };
    }
    super.loadRecord(record);
    this.formatForm(record.country);
  }

  /**
   * `mailing-address` is a special attribute token to indicate mailing fields + country.
   *
   * @param {object[]} mailingFieldsOrder - `fieldsOrder` from `getFormFormat`
   * @returns {object[]} in the same structure as `mailingFieldsOrder` but including non-mail fields
   */
  computeVisibleFields(mailingFieldsOrder) {
    let addressFields = this._elements.form.dataset.addressFields;
    if (addressFields) {
      let requestedFieldClasses = addressFields.trim().split(/\s+/);
      let fieldClasses = [];
      if (requestedFieldClasses.includes("mailing-address")) {
        fieldClasses = fieldClasses.concat(mailingFieldsOrder);
        // `country` isn't part of the `mailingFieldsOrder` so add it when filling a mailing-address
        requestedFieldClasses.splice(requestedFieldClasses.indexOf("mailing-address"), 1,
                                     "country");
      }

      for (let fieldClassName of requestedFieldClasses) {
        fieldClasses.push({
          fieldId: fieldClassName,
          newLine: fieldClassName == "name",
        });
      }
      return fieldClasses;
    }

    // This is the default which is shown in the management interface and includes all fields.
    return mailingFieldsOrder.concat([
      {
        fieldId: "country",
      },
      {
        fieldId: "tel",
      },
      {
        fieldId: "email",
        newLine: true,
      },
    ]);
  }

  /**
   * Format the form based on country. The address-level1 and postal-code labels
   * should be specific to the given country.
   * @param  {string} country
   */
  formatForm(country) {
    const {
      addressLevel1Label,
      postalCodeLabel,
      fieldsOrder: mailingFieldsOrder,
      postalCodePattern,
    } = this.getFormFormat(country);
    this._elements.addressLevel1Label.dataset.localization = addressLevel1Label;
    this._elements.postalCodeLabel.dataset.localization = postalCodeLabel;
    let fieldClasses = this.computeVisibleFields(mailingFieldsOrder);
    this.arrangeFields(fieldClasses);
    this.updatePostalCodeValidation(postalCodePattern);
  }

  /**
   * Update address field visibility and order based on libaddressinput data.
   *
   * @param {object[]} fieldsOrder array of objects with `fieldId` and optional `newLine` properties
   */
  arrangeFields(fieldsOrder) {
    let fields = [
      "name",
      "organization",
      "street-address",
      "address-level2",
      "address-level1",
      "postal-code",
      "country",
      "tel",
      "email",
    ];
    let inputs = [];
    for (let i = 0; i < fieldsOrder.length; i++) {
      let {fieldId, newLine} = fieldsOrder[i];
      let container = this._elements.form.querySelector(`#${fieldId}-container`);
      let containerInputs = [...container.querySelectorAll("input, textarea, select")];
      containerInputs.forEach(function(input) { input.disabled = false; });
      inputs.push(...containerInputs);
      container.style.display = "flex";
      container.style.order = i;
      container.style.pageBreakAfter = newLine ? "always" : "auto";
      // Remove the field from the list of fields
      fields.splice(fields.indexOf(fieldId), 1);
    }
    for (let i = 0; i < inputs.length; i++) {
      // Assign tabIndex starting from 1
      inputs[i].tabIndex = i + 1;
    }
    // Hide the remaining fields
    for (let field of fields) {
      let container = this._elements.form.querySelector(`#${field}-container`);
      container.style.display = "none";
      for (let input of [...container.querySelectorAll("input, textarea, select")]) {
        input.disabled = true;
      }
    }
  }

  updatePostalCodeValidation(postalCodePattern) {
    let postalCodeInput = this._elements.form.querySelector("#postal-code");
    if (postalCodePattern && postalCodeInput.style.display != "none") {
      postalCodeInput.setAttribute("pattern", postalCodePattern);
    } else {
      postalCodeInput.removeAttribute("pattern");
    }
  }

  populateCountries() {
    let fragment = document.createDocumentFragment();
    for (let country of this.supportedCountries) {
      let option = new Option();
      option.value = country;
      option.dataset.localizationRegion = country.toLowerCase();
      fragment.appendChild(option);
    }
    this._elements.country.appendChild(fragment);
  }

  handleChange(event) {
    if (event.target == this._elements.country) {
      this.formatForm(event.target.value);
    }
    super.handleChange(event);
  }

  attachEventListeners() {
    this._elements.form.addEventListener("change", this);
    super.attachEventListeners();
  }
}

class EditCreditCard extends EditAutofillForm {
  /**
   * @param {HTMLElement[]} elements
   * @param {object} record with a decrypted cc-number
   * @param {object} addresses in an object with guid keys for the billing address picker.
   * @param {object} config
   * @param {function} config.isCCNumber Function to determine if a string is a valid CC number.
   */
  constructor(elements, record, addresses, config) {
    super(elements);

    this._addresses = addresses;
    Object.assign(this, config);
    Object.assign(this._elements, {
      ccNumber: this._elements.form.querySelector("#cc-number"),
      invalidCardNumberStringElement: this._elements.form.querySelector("#invalidCardNumberString"),
      month: this._elements.form.querySelector("#cc-exp-month"),
      year: this._elements.form.querySelector("#cc-exp-year"),
      billingAddress: this._elements.form.querySelector("#billingAddressGUID"),
      billingAddressRow: this._elements.form.querySelector(".billingAddressRow"),
    });

    this.loadRecord(record, addresses);
    this.attachEventListeners();
  }

  loadRecord(record, addresses, preserveFieldValues) {
    // _record must be updated before generateYears and generateBillingAddressOptions are called.
    this._record = record;
    this._addresses = addresses;
    this.generateBillingAddressOptions();
    if (!preserveFieldValues) {
      // Re-generating the years will reset the selected option.
      this.generateYears();
      super.loadRecord(record);

      // Resetting the form in the super.loadRecord won't clear custom validity
      // state so reset it here. Since the cc-number field is disabled upon editing
      // we don't need to recaclulate its validity here.
      this._elements.ccNumber.setCustomValidity("");
    }
  }

  generateYears() {
    const count = 11;
    const currentYear = new Date().getFullYear();
    const ccExpYear = this._record && this._record["cc-exp-year"];

    // Clear the list
    this._elements.year.textContent = "";

    // Provide an empty year option
    this._elements.year.appendChild(new Option());

    if (ccExpYear && ccExpYear < currentYear) {
      this._elements.year.appendChild(new Option(ccExpYear));
    }

    for (let i = 0; i < count; i++) {
      let year = currentYear + i;
      let option = new Option(year);
      this._elements.year.appendChild(option);
    }

    if (ccExpYear && ccExpYear > currentYear + count) {
      this._elements.year.appendChild(new Option(ccExpYear));
    }
  }

  generateBillingAddressOptions() {
    let billingAddressGUID = this._record && this._record.billingAddressGUID;

    this._elements.billingAddress.textContent = "";

    this._elements.billingAddress.appendChild(new Option("", ""));

    let hasAddresses = false;
    for (let [guid, address] of Object.entries(this._addresses)) {
      hasAddresses = true;
      let selected = guid == billingAddressGUID;
      let option = new Option(this.getAddressLabel(address), guid, selected, selected);
      this._elements.billingAddress.appendChild(option);
    }

    this._elements.billingAddressRow.hidden = !hasAddresses;
  }

  attachEventListeners() {
    this._elements.form.addEventListener("change", this);
    super.attachEventListeners();
  }

  handleChange(event) {
    super.handleChange(event);

    if (event.target != this._elements.ccNumber) {
      return;
    }

    let ccNumberField = this._elements.ccNumber;

    // Mark the cc-number field as invalid if the number is empty or invalid.
    if (!this.isCCNumber(ccNumberField.value)) {
      let invalidCardNumberString = this._elements.invalidCardNumberStringElement.textContent;
      ccNumberField.setCustomValidity(invalidCardNumberString || " ");
    }
  }

  handleInput(event) {
    // Clear the error message if cc-number is valid
    if (event.target == this._elements.ccNumber &&
        this.isCCNumber(this._elements.ccNumber.value)) {
      this._elements.ccNumber.setCustomValidity("");
    }
    super.handleInput(event);
  }
}
