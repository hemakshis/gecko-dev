/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { createFactory, PureComponent } = require("devtools/client/shared/vendor/react");
const dom = require("devtools/client/shared/vendor/react-dom-factories");
const PropTypes = require("devtools/client/shared/vendor/react-prop-types");
const { getStr } = require("devtools/client/inspector/layout/utils/l10n");

const FlexContainerItem = createFactory(require("./FlexContainerItem"));

const Types = require("../types");

class FlexContainerList extends PureComponent {
  static get propTypes() {
    return {
      flexbox: PropTypes.shape(Types.flexbox).isRequired,
      getSwatchColorPickerTooltip: PropTypes.func.isRequired,
      onHideBoxModelHighlighter: PropTypes.func.isRequired,
      onSetFlexboxOverlayColor: PropTypes.func.isRequired,
      onShowBoxModelHighlighterForNode: PropTypes.func.isRequired,
      onToggleFlexboxHighlighter: PropTypes.func.isRequired,
      setSelectedNode: PropTypes.func.isRequired,
    };
  }

  render() {
    const {
      flexbox,
      getSwatchColorPickerTooltip,
      onHideBoxModelHighlighter,
      onSetFlexboxOverlayColor,
      onShowBoxModelHighlighterForNode,
      onToggleFlexboxHighlighter,
      setSelectedNode,
    } = this.props;

    return (
      dom.div({ className: "flexbox-container" },
        dom.span({}, getStr("flexbox.overlayFlexbox")),
        dom.ul(
          {
            id: "flexbox-list",
            className: "devtools-monospace",
          },
          FlexContainerItem({
            key: flexbox.id,
            flexbox,
            getSwatchColorPickerTooltip,
            onHideBoxModelHighlighter,
            onSetFlexboxOverlayColor,
            onShowBoxModelHighlighterForNode,
            onToggleFlexboxHighlighter,
            setSelectedNode,
          })
        )
      )
    );
  }
}

module.exports = FlexContainerList;
