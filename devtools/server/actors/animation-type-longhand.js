/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// Types of animation types of longhand properties.
exports.ANIMATION_TYPE_FOR_LONGHANDS = [
  ["discrete", new Set([
    "align-content",
    "align-items",
    "align-self",
    "-moz-appearance",
    "backface-visibility",
    "background-attachment",
    "background-blend-mode",
    "background-clip",
    "background-image",
    "background-origin",
    "background-repeat",
    "border-bottom-style",
    "border-collapse",
    "border-image-outset",
    "border-image-repeat",
    "border-image-slice",
    "border-image-source",
    "border-image-width",
    "border-left-style",
    "border-right-style",
    "border-top-style",
    "-moz-box-align",
    "box-decoration-break",
    "-moz-box-direction",
    "-moz-box-ordinal-group",
    "-moz-box-orient",
    "-moz-box-pack",
    "box-sizing",
    "caption-side",
    "clear",
    "clip-rule",
    "color-adjust",
    "color-interpolation",
    "color-interpolation-filters",
    "column-fill",
    "column-rule-style",
    "column-span",
    "contain",
    "content",
    "counter-increment",
    "counter-reset",
    "cursor",
    "direction",
    "dominant-baseline",
    "empty-cells",
    "fill-rule",
    "flex-direction",
    "flex-wrap",
    "float",
    "-moz-float-edge",
    "font-family",
    "font-feature-settings",
    "font-kerning",
    "font-language-override",
    "font-style",
    "font-synthesis",
    "font-variant-alternates",
    "font-variant-caps",
    "font-variant-east-asian",
    "font-variant-ligatures",
    "font-variant-numeric",
    "font-variant-position",
    "-moz-force-broken-image-icon",
    "grid-auto-columns",
    "grid-auto-flow",
    "grid-auto-rows",
    "grid-column-end",
    "grid-column-start",
    "grid-row-end",
    "grid-row-start",
    "grid-template-areas",
    "grid-template-columns",
    "grid-template-rows",
    "hyphens",
    "image-orientation",
    "image-rendering",
    "ime-mode",
    "initial-letter",
    "isolation",
    "justify-content",
    "justify-items",
    "justify-self",
    "list-style-image",
    "list-style-position",
    "list-style-type",
    "marker-end",
    "marker-mid",
    "marker-start",
    "mask-clip",
    "mask-composite",
    "mask-image",
    "mask-mode",
    "mask-origin",
    "mask-repeat",
    "mask-type",
    "mix-blend-mode",
    "object-fit",
    "-moz-orient",
    "-moz-osx-font-smoothing",
    "outline-style",
    "overflow-clip-box-block",
    "overflow-clip-box-inline",
    "overflow-wrap",
    "overflow-x",
    "overflow-y",
    "overscroll-behavior-x",
    "overscroll-behavior-y",
    "page-break-after",
    "page-break-before",
    "page-break-inside",
    "paint-order",
    "pointer-events",
    "position",
    "quotes",
    "resize",
    "ruby-align",
    "ruby-position",
    "scroll-behavior",
    "scroll-snap-coordinate",
    "scroll-snap-destination",
    "scroll-snap-points-x",
    "scroll-snap-points-y",
    "scroll-snap-type-x",
    "scroll-snap-type-y",
    "shape-rendering",
    "-moz-stack-sizing",
    "scrollbar-width",
    "stroke-linecap",
    "stroke-linejoin",
    "table-layout",
    "text-align",
    "text-align-last",
    "text-anchor",
    "text-combine-upright",
    "text-decoration-line",
    "text-decoration-style",
    "text-emphasis-position",
    "text-emphasis-style",
    "text-justify",
    "text-orientation",
    "text-overflow",
    "text-rendering",
    "-moz-text-size-adjust",
    "-webkit-text-stroke-width",
    "text-transform",
    "touch-action",
    "transform-box",
    "transform-style",
    "unicode-bidi",
    "-moz-user-focus",
    "-moz-user-input",
    "-moz-user-modify",
    "-moz-user-select",
    "vector-effect",
    "visibility",
    "white-space",
    "will-change",
    "-moz-window-dragging",
    "word-break",
    "writing-mode",
  ])],
  ["none", new Set([
    "animation-delay",
    "animation-direction",
    "animation-duration",
    "animation-fill-mode",
    "animation-iteration-count",
    "animation-name",
    "animation-play-state",
    "animation-timing-function",
    "-moz-binding",
    "block-size",
    "border-block-end-color",
    "border-block-end-style",
    "border-block-end-width",
    "border-block-start-color",
    "border-block-start-style",
    "border-block-start-width",
    "border-inline-end-color",
    "border-inline-end-style",
    "border-inline-end-width",
    "border-inline-start-color",
    "border-inline-start-style",
    "border-inline-start-width",
    "-moz-context-properties",
    "-moz-control-character-visibility",
    "display",
    "font-optical-sizing",
    "inline-size",
    "inset-block-end",
    "inset-block-start",
    "inset-inline-end",
    "inset-inline-start",
    "margin-block-end",
    "margin-block-start",
    "margin-inline-end",
    "margin-inline-start",
    "-moz-math-display",
    "max-block-size",
    "max-inline-size",
    "min-block-size",
    "-moz-min-font-size-ratio",
    "min-inline-size",
    "offset-path",
    "padding-block-end",
    "padding-block-start",
    "padding-inline-end",
    "padding-inline-start",
    "rotate",
    "scale",
    "-moz-script-level",
    "-moz-top-layer",
    "transition-delay",
    "transition-duration",
    "transition-property",
    "transition-timing-function",
    "translate",
    "-moz-window-shadow",
  ])],
  ["color", new Set([
    "background-color",
    "border-bottom-color",
    "border-left-color",
    "border-right-color",
    "border-top-color",
    "caret-color",
    "color",
    "column-rule-color",
    "flood-color",
    "-moz-font-smoothing-background-color",
    "lighting-color",
    "outline-color",
    "scrollbar-face-color",
    "scrollbar-track-color",
    "stop-color",
    "text-decoration-color",
    "text-emphasis-color",
    "-webkit-text-fill-color",
    "-webkit-text-stroke-color",
  ])],
  ["custom", new Set([
    "background-position-x",
    "background-position-y",
    "background-size",
    "border-bottom-width",
    "border-left-width",
    "border-right-width",
    "border-spacing",
    "border-top-width",
    "clip",
    "clip-path",
    "column-count",
    "column-rule-width",
    "filter",
    "font-stretch",
    "font-variation-settings",
    "font-weight",
    "-moz-image-region",
    "mask-position-x",
    "mask-position-y",
    "mask-size",
    "object-position",
    "order",
    "perspective-origin",
    "shape-outside",
    "stroke-dasharray",
    "transform",
    "transform-origin",
    "-moz-window-transform",
    "-moz-window-transform-origin",
  ])],
  ["coord", new Set([
    "border-bottom-left-radius",
    "border-bottom-right-radius",
    "border-top-left-radius",
    "border-top-right-radius",
    "bottom",
    "column-gap",
    "column-width",
    "flex-basis",
    "height",
    "left",
    "letter-spacing",
    "line-height",
    "margin-bottom",
    "margin-left",
    "margin-right",
    "margin-top",
    "max-height",
    "max-width",
    "min-height",
    "min-width",
    "-moz-outline-radius-bottomleft",
    "-moz-outline-radius-bottomright",
    "-moz-outline-radius-topleft",
    "-moz-outline-radius-topright",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "padding-top",
    "perspective",
    "right",
    "row-gap",
    "shape-margin",
    "stroke-dashoffset",
    "stroke-width",
    "-moz-tab-size",
    "text-indent",
    "top",
    "vertical-align",
    "width",
    "word-spacing",
    "z-index",
  ])],
  ["float", new Set([
    "-moz-box-flex",
    "fill-opacity",
    "flex-grow",
    "flex-shrink",
    "flood-opacity",
    "font-size-adjust",
    "opacity",
    "shape-image-threshold",
    "stop-opacity",
    "stroke-miterlimit",
    "stroke-opacity",
    "-moz-window-opacity",
  ])],
  ["shadow", new Set([
    "box-shadow",
    "text-shadow",
  ])],
  ["paintServer", new Set([
    "fill",
    "stroke",
  ])],
  ["length", new Set([
    "font-size",
    "outline-offset",
    "outline-width",
  ])],
];
