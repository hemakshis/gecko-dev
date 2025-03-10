/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { createFactory, PureComponent } = require("devtools/client/shared/vendor/react");
const dom = require("devtools/client/shared/vendor/react-dom-factories");
const PropTypes = require("devtools/client/shared/vendor/react-prop-types");

const DebugTargetItem = createFactory(require("./DebugTargetItem"));

/**
 * This component displays list of debug target.
 */
class DebugTargetList extends PureComponent {
  static get propTypes() {
    return {
      actionComponent: PropTypes.any.isRequired,
      detailComponent: PropTypes.any.isRequired,
      dispatch: PropTypes.func.isRequired,
      targets: PropTypes.arrayOf(PropTypes.object).isRequired,
    };
  }

  render() {
    const { actionComponent, detailComponent, dispatch, targets } = this.props;

    return dom.ul(
      {
        className: "debug-target-list",
      },
      targets.map(target =>
        DebugTargetItem({ actionComponent, detailComponent, dispatch, target })),
    );
  }
}

module.exports = DebugTargetList;
