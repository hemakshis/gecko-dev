let m = parseModule(`
  const root = newGlobal();
  minorgc();
  root.eval();
`);
instantiateModule(m);
evaluateModule(m);
