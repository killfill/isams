// Precarga para las pruebas que levantan el CLI como proceso aparte.
//
// El CLI arma https://{tenant}.isams.cloud/... y no tiene —ni debe tener— una
// opción para apuntar a otro host: un flag así en producción es una vía para
// mandar el refresh token a cualquier parte. Así que el desvío se inyecta desde
// afuera, con --import, y solo existe mientras corren las pruebas.
//
//   NODE_OPTIONS='--import ./test/fetchredirect.mjs' ISAMS_TEST_ORIGIN=http://127.0.0.1:1234
const target = process.env.ISAMS_TEST_ORIGIN;
if (target) {
  const orig = globalThis.fetch;
  globalThis.fetch = (u, o) => orig(String(u).replace(/^https:\/\/[^/]+/, target), o);
}
