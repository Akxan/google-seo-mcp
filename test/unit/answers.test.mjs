import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { splitBlocks, evaluateAnswer, bestBlockFor, expectationsOf, sentences, termWeights, stem } from "../../dist/tools/geo.js";

const page = `<html><body>
  <nav><a href="/">Inicio</a></nav>
  <main>
    <h1>Tours en Sevilla</h1>
    <p>Bienvenido a nuestra web de tours.</p>
    <h2>¿Cuánto cuesta un tour por el Alcázar?</h2>
    <p>El tour del Alcázar cuesta 45 euros por persona e incluye la entrada. Reservando con antelación el precio baja.</p>
    <h2>¿Cómo llego al Alcázar desde la estación?</h2>
    <p>El Alcázar está en el centro histórico y la ciudad es muy agradable para pasear en cualquier época del año, con sus calles estrechas y sus naranjos que dan sombra durante los meses de verano, cuando el calor aprieta de verdad y conviene caminar temprano por la mañana o bien esperar a que caiga la tarde para disfrutar del paseo con tranquilidad, que es como mejor se aprecia el barrio de Santa Cruz y sus patios llenos de flores.</p>
    <p>Para llegar al Alcázar desde la estación de Santa Justa toma el autobús C1.</p>
    <h2>Horario</h2>
    <p>Abierto.</p>
  </main>
  <footer><p>Contacto</p></footer>
</body></html>`;

test("splitBlocks cuts the body into heading-delimited passages and drops chrome", () => {
  const blocks = splitBlocks(cheerio.load(page));
  const headings = blocks.map((b) => b.heading);
  assert.ok(headings.includes("¿Cuánto cuesta un tour por el Alcázar?"));
  assert.ok(!blocks.some((b) => /Inicio|Contacto/.test(b.text)), "nav and footer are removed");
  const precio = blocks.find((b) => b.heading.startsWith("¿Cuánto"));
  assert.match(precio.text, /45 euros/);
  assert.equal(precio.hasNumber, true);
});

test("a direct answer right under its heading is ok", () => {
  const blocks = splitBlocks(cheerio.load(page));
  const hit = bestBlockFor("cuánto cuesta un tour por el alcázar", blocks);
  assert.ok(hit, "the passage is found");
  assert.equal(hit.check.verdict, "ok");
  assert.match(hit.check.answer, /45 euros/);
  assert.deepEqual(hit.check.issues, [], "the figure is present, so no issue");
});

test("an answer sitting behind a long preamble is buried, not ok", () => {
  const blocks = splitBlocks(cheerio.load(page));
  const hit = bestBlockFor("cómo llego al alcázar desde la estación", blocks);
  assert.equal(hit.check.verdict, "buried");
  assert.ok(hit.check.leadWords > 60, `leadWords=${hit.check.leadWords}`);
});

test("a passage nothing on the page covers comes back as no candidate", () => {
  const blocks = splitBlocks(cheerio.load(page));
  assert.equal(bestBlockFor("dónde aparcar la autocaravana gratis", blocks), null);
});

test("a one-word passage is thin", () => {
  const blocks = splitBlocks(cheerio.load(page));
  const hit = bestBlockFor("horario", blocks);
  assert.equal(hit.check.verdict, "thin");
});

test("the question shape sets what the passage must contain", () => {
  assert.deepEqual(expectationsOf("¿cuánto cuesta el tour?"), ["number"]);
  assert.deepEqual(expectationsOf("how to get to the cathedral"), ["steps"]);
  assert.deepEqual(expectationsOf("best tapas bars in Seville"), ["list"]);
  assert.deepEqual(expectationsOf("historia del alcázar"), []);
  const noNumber = { heading: "¿Cuánto cuesta?", level: 2, text: "El precio depende de la temporada y del tipo de visita que elijas para el grupo.", words: 15, hasList: false, hasTable: false, hasNumber: false };
  assert.match(evaluateAnswer("¿cuánto cuesta la visita?", noNumber).issues[0], /no number/);
});

test("sentences splits on terminators without leaving blanks", () => {
  assert.deepEqual(sentences("Uno. Dos! ¿Tres?  Cuatro"), ["Uno.", "Dos!", "¿Tres?", "Cuatro"]);
  assert.deepEqual(sentences(""), []);
});

test("terms appearing in prose with no heading aimed at them is weak, not ok", () => {
  const incidental = { heading: "Sobre nosotros", level: 2, text: "Organizamos excursiones a Ronda desde Sevilla con guías locales y grupos pequeños durante todo el año, saliendo del centro de Sevilla por la mañana.", words: 24, hasList: false, hasTable: false, hasNumber: false };
  const r = evaluateAnswer("how far is ronda from seville", incidental);
  assert.equal(r.verdict, "weak", "the passage mentions Ronda and Seville but nothing is headed for the question");
  assert.ok(r.issues.some((i) => /no number/.test(i)), "a distance question wants a figure");
});

test("a word that appears on every passage stops counting as evidence", () => {
  const blocks = [
    { heading: "Tours en Sevilla", level: 2, text: "Sevilla es preciosa en primavera y ofrecemos rutas guiadas cada semana.", words: 11, hasList: false, hasTable: false, hasNumber: false },
    { heading: "Flamenco en Sevilla", level: 2, text: "Sevilla tiene tablaos por todo el centro y conviene reservar con antelación.", words: 12, hasList: false, hasTable: false, hasNumber: false },
    { heading: "Aparcamiento en Sevilla", level: 2, text: "Sevilla cuenta con aparcamientos subterráneos junto al centro histórico por 20 euros al día.", words: 14, hasList: false, hasTable: false, hasNumber: true },
  ];
  const w = termWeights(["sevilla", "aparcamiento"], blocks);
  assert.ok(w.get(stem("sevilla")) < 0.1, "on every passage, so worth nothing");
  assert.ok(w.get(stem("aparcamiento")) > w.get(stem("sevilla")) * 5, "on one passage, so it decides");
  assert.match(bestBlockFor("dónde aparcar en sevilla", blocks).block.heading, /Aparcamiento/, "aparcar must reach aparcamientos despite the inflection");
});
