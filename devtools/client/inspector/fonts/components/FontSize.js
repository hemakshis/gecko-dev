/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { createFactory, PureComponent } = require("devtools/client/shared/vendor/react");
const PropTypes = require("devtools/client/shared/vendor/react-prop-types");

const FontPropertyValue = createFactory(require("./FontPropertyValue"));

const { getStr } = require("../utils/l10n");
const { getUnitFromValue, getStepForUnit } = require("../utils/font-utils");

class FontSize extends PureComponent {
  static get propTypes() {
    return {
      onChange: PropTypes.func.isRequired,
      value: PropTypes.string.isRequired,
    };
  }

  constructor(props) {
    super(props);
    this.historicMax = {};
  }

  render() {
    const value = parseFloat(this.props.value);
    const unit = getUnitFromValue(this.props.value);
    let max;
    switch (unit) {
      case "em":
      case "rem":
        max = 4;
        break;
      case "vh":
      case "vw":
      case "vmin":
      case "vmax":
        max = 10;
        break;
      case "%":
        max = 200;
        break;
      default:
        max = 72;
        break;
    }

    // Allow the upper bound to increase so it accomodates the out-of-bounds value.
    max = Math.max(max, value);
    // Ensure we store the max value ever reached for this unit type. This will be the
    // max value of the input and slider. Without this memoization, the value and slider
    // thumb get clamped at the upper bound while decrementing an out-of-bounds value.
    this.historicMax[unit] = this.historicMax[unit]
      ? Math.max(this.historicMax[unit], max)
      : max;

    return FontPropertyValue({
      allowAutoIncrement: true,
      label: getStr("fontinspector.fontSizeLabel"),
      min: 0,
      max: this.historicMax[unit],
      name: "font-size",
      onChange: this.props.onChange,
      step: getStepForUnit(unit),
      unit,
      unitOptions: ["em", "rem", "%", "px", "vh", "vw"],
      value,
    });
  }
}

module.exports = FontSize;
