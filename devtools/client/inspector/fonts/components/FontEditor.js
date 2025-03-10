/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { createFactory, PureComponent } = require("devtools/client/shared/vendor/react");
const dom = require("devtools/client/shared/vendor/react-dom-factories");
const PropTypes = require("devtools/client/shared/vendor/react-prop-types");

const FontName = createFactory(require("./FontName"));
const FontPropertyValue = createFactory(require("./FontPropertyValue"));
const FontSize = createFactory(require("./FontSize"));
const FontStyle = createFactory(require("./FontStyle"));
const FontWeight = createFactory(require("./FontWeight"));
const LineHeight = createFactory(require("./LineHeight"));

const { getStr } = require("../utils/l10n");
const Types = require("../types");

// Maximum number of font families to be shown by default. Any others will be hidden
// under a collapsed <details> element with a toggle to reveal them.
const MAX_FONTS = 3;

class FontEditor extends PureComponent {
  static get propTypes() {
    return {
      fontEditor: PropTypes.shape(Types.fontEditor).isRequired,
      onInstanceChange: PropTypes.func.isRequired,
      onPropertyChange: PropTypes.func.isRequired,
      onToggleFontHighlight: PropTypes.func.isRequired,
    };
  }

  /**
   * Naive implementation to get increment step for variable font axis that ensures
   * a wide spectrum of precision based on range of values between min and max.
   *
   * @param  {Number|String} min
   *         Minumum value for range.
   * @param  {Number|String} max
   *         Maximum value for range.
   * @return {String}
   *         Step value used in range input for font axis.
   */
  getAxisStep(min, max) {
    let step = 1;
    const delta = parseInt(max, 10) - parseInt(min, 10);

    if (delta <= 1) {
      step = 0.001;
    } else if (delta <= 10) {
      step = 0.01;
    } else if (delta <= 100) {
      step = 0.1;
    }

    return step.toString();
  }

  /**
   * Get an array of FontPropertyValue components with editing controls
   * for of the given variable font axes. If no axes were given, return null.
   * If an axis has a value in the fontEditor store (i.e.: it was declared in CSS or
   * it was changed using the font editor), use its value, otherwise use the font axis
   * default.
   *
   * @param  {Array} fontAxes
   *         Array of font axis instances
   * @param  {Object} editedAxes
   *         Object with axes and values edited by the user or predefined in the CSS
   *         declaration for font-variation-settings.
   * @return {Array|null}
   */
  renderAxes(fontAxes = [], editedAxes) {
    if (!fontAxes.length) {
      return null;
    }

    return fontAxes.map(axis => {
      return FontPropertyValue({
        key: axis.tag,
        className: "font-control-axis",
        label: axis.name,
        min: axis.minValue,
        max: axis.maxValue,
        name: axis.tag,
        onChange: this.props.onPropertyChange,
        step: this.getAxisStep(axis.minValue, axis.maxValue),
        unit: null,
        value: editedAxes[axis.tag] || axis.defaultValue,
      });
    });
  }

  /**
   * Render fonts used on the selected node grouped by font-family.
   *
   * @param {Array} fonts
   *        Fonts used on selected node.
   * @return {DOMNode}
   */
  renderUsedFonts(fonts) {
    if (!fonts.length) {
      return null;
    }

    // Group fonts by family name.
    const fontGroups = fonts.reduce((acc, font) => {
      const family = font.CSSFamilyName.toString();
      acc[family] = acc[family] || [];
      acc[family].push(font);
      return acc;
    }, {});

    const renderedFontGroups = Object.keys(fontGroups).map(family => {
      return this.renderFontGroup(family, fontGroups[family]);
    });

    const topFontsList = renderedFontGroups.slice(0, MAX_FONTS);
    const moreFontsList = renderedFontGroups.slice(MAX_FONTS, renderedFontGroups.length);

    const moreFonts = !moreFontsList.length
      ? null
      : dom.details({},
          dom.summary({},
            dom.span({ className: "label-open" }, getStr("fontinspector.showMore")),
            dom.span({ className: "label-close" }, getStr("fontinspector.showLess"))
          ),
          moreFontsList
        );

    return dom.label(
      {
        className: "font-control font-control-used-fonts",
      },
      dom.span(
        {
          className: "font-control-label",
        },
        getStr("fontinspector.usedFontsLabel")
      ),
      dom.div(
        {
          className: "font-control-box",
        },
        topFontsList,
        moreFonts
      )
    );
  }

  renderFontGroup(family, fonts = []) {
    const group = fonts.map(font => {
      return FontName({
        font,
        onToggleFontHighlight: this.props.onToggleFontHighlight,
      });
    });

    return dom.div(
      {
        className: "font-group"
      },
      dom.div(
        {
          className: "font-family-name"
        },
        family),
      group
    );
  }

  renderFontSize(value) {
    return value && FontSize({
      key: `${this.props.fontEditor.id}:font-size`,
      onChange: this.props.onPropertyChange,
      value,
    });
  }

  renderLineHeight(value) {
    return value && LineHeight({
      key: `${this.props.fontEditor.id}:line-height`,
      onChange: this.props.onPropertyChange,
      value,
    });
  }

  renderFontStyle(value) {
    return value && FontStyle({
      onChange: this.props.onPropertyChange,
      value,
    });
  }

  renderFontWeight(value) {
    return value && FontWeight({
      onChange: this.props.onPropertyChange,
      value,
    });
  }

  /**
   * Get a dropdown which allows selecting between variation instances defined by a font.
   *
   * @param {Array} fontInstances
   *        Named variation instances as provided with the font file.
   * @param {Object} selectedInstance
   *        Object with information about the currently selected variation instance.
   *        Example:
   *        {
   *          name: "Custom",
   *          values: []
   *        }
   * @return {DOMNode}
   */
  renderInstances(fontInstances = [], selectedInstance) {
    // Append a "Custom" instance entry which represents the latest manual axes changes.
    const customInstance = {
      name: getStr("fontinspector.customInstanceName"),
      values: this.props.fontEditor.customInstanceValues
    };
    fontInstances = [ ...fontInstances, customInstance ];

    // Generate the <option> elements for the dropdown.
    const instanceOptions = fontInstances.map(instance =>
      dom.option(
        {
          value: instance.name,
          selected: instance.name === selectedInstance.name ? "selected" : null,
        },
        instance.name
      )
    );

    // Generate the dropdown.
    const instanceSelect = dom.select(
      {
        className: "font-control-input font-value-select",
        onChange: (e) => {
          const instance = fontInstances.find(inst => e.target.value === inst.name);
          instance && this.props.onInstanceChange(instance.name, instance.values);
        }
      },
      instanceOptions
    );

    return dom.label(
      {
        className: "font-control",
      },
      dom.span(
        {
          className: "font-control-label",
        },
        getStr("fontinspector.fontInstanceLabel")
      ),
      instanceSelect
    );
  }

  renderWarning(warning) {
    return dom.div(
      {
        id: "font-editor"
      },
      dom.div(
        {
          className: "devtools-sidepanel-no-result"
        },
        warning
      )
    );
  }

  render() {
    const { fontEditor } = this.props;
    const { fonts, axes, instance, properties, warning } = fontEditor;
    // Pick the first font to show editor controls regardless of how many fonts are used.
    const font = fonts[0];
    const hasFontAxes = font && font.variationAxes;
    const hasFontInstances = font && font.variationInstances
      && font.variationInstances.length > 0;
    const hasSlantOrItalicAxis = hasFontAxes && font.variationAxes.find(axis => {
      return axis.tag === "slnt" || axis.tag === "ital";
    });
    const hasWeightAxis = hasFontAxes && font.variationAxes.find(axis => {
      return axis.tag === "wght";
    });

    // Show the empty state with a warning message when a used font was not found.
    if (!font) {
      return this.renderWarning(warning);
    }

    return dom.div(
      {
        id: "font-editor"
      },
      // Always render UI for used fonts.
      this.renderUsedFonts(fonts),
      // Render UI for font variation instances if they are defined.
      hasFontInstances && this.renderInstances(font.variationInstances, instance),
      // Always render UI for font size.
      this.renderFontSize(properties["font-size"]),
      // Always render UI for line height.
      this.renderLineHeight(properties["line-height"]),
      // Render UI for font weight if no "wght" registered axis is defined.
      !hasWeightAxis && this.renderFontWeight(properties["font-weight"]),
      // Render UI for font style if no "slnt" or "ital" registered axis is defined.
      !hasSlantOrItalicAxis && this.renderFontStyle(properties["font-style"]),
      // Render UI for each variable font axis if any are defined.
      hasFontAxes && this.renderAxes(font.variationAxes, axes)
    );
  }
}

module.exports = FontEditor;
