// |reftest| skip error:SyntaxError -- regexp-unicode-property-escapes is not supported
// Copyright 2018 Mathias Bynens. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
author: Mathias Bynens
description: >
  Loose matching must not be applied when matching properties and values in
  Unicode property escapes.
esid: sec-static-semantics-unicodematchproperty-p
negative:
  phase: parse
  type: SyntaxError
features: [regexp-unicode-property-escapes]
---*/

throw "Test262: This statement should not be evaluated.";

/\P{lowercase}/u;
