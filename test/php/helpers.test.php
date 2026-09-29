<?php
// Pure logic of the WordPress helpers, run without WordPress: both scripts stop before their
// dispatch when SEO_MCP_TEST is defined. Run through test/unit/php.test.mjs (part of npm test).
define('SEO_MCP_TEST', true);
$args = [];
require __DIR__ . '/../../scripts/mfn-builder.php';
require __DIR__ . '/../../scripts/wp-helper.php';

$checks = 0; $failures = [];
function check(string $name, bool $ok): void { global $checks, $failures; $checks++; if (!$ok) $failures[] = $name; }
function throws(callable $fn): bool { try { $fn(); return false; } catch (RuntimeException $e) { return true; } }

// --- Yoast social profiles: which URLs belong to a named platform ---------------------------
check('instagram', h_social_platform('https://www.instagram.com/octocat/') === 'instagram');
check('youtube channel', h_social_platform('https://www.youtube.com/@octocat') === 'youtube');
check('youtu.be short link', h_social_platform('https://youtu.be/abc123') === 'youtube');
check('pinterest country domain', h_social_platform('https://www.pinterest.es/octocat/') === 'pinterest');
check('wikipedia', h_social_platform('https://en.wikipedia.org/wiki/Example') === 'wikipedia');
check('tiktok has no named field', h_social_platform('https://www.tiktok.com/@octocat') === null);
check('not a url', h_social_platform('not a url') === null);
[$named, $rest] = h_split_social([
  'https://www.instagram.com/octocat/', 'https://www.tiktok.com/@octocat',
  'https://www.youtube.com/@octocat', 'https://www.instagram.com/second/',
]);
check('split: first URL per platform is named', $named === ['instagram' => 'https://www.instagram.com/octocat/', 'youtube' => 'https://www.youtube.com/@octocat']);
check('split: a second URL of the same platform stays in the rest', $rest === ['https://www.tiktok.com/@octocat', 'https://www.instagram.com/second/']);

// --- Muffin Builder: nested entries are listed and edited by path ----------------------------
$toggle = ['type' => 'toggle', 'uid' => 'abc123def', 'attr' => ['tag' => 'h5', 'tabs' => [
  ['title' => 'Email', 'content' => 'info@example.com', 'icon' => 'icon-email', 'image' => ''],
  ['title' => 'Hours', 'content' => '9 - 18', 'icon' => 'icon-clock', 'image' => ''],
]]];
$sections = [['wraps' => [['items' => [$toggle]]]]];
$fields = (array) mfn_summarize($sections)[0]['fields'];
check('summarize lists nested entries by path', ($fields['tabs.1.content'] ?? null) === '9 - 18' && ($fields['tabs.0.title'] ?? null) === 'Email');

$created = [];
$item = $toggle;
check('replace a nested string returns the old value', mfn_set_field($item, 'tabs.1.content', '10 - 19', $created) === '9 - 18' && $item['attr']['tabs'][1]['content'] === '10 - 19');
check('top-level field still works', mfn_set_field($item, 'tag', 'h4', $created) === 'h5' && $item['attr']['tag'] === 'h4');

$old = mfn_set_field($item, 'tabs.2.title', 'Phone', $created);
check('append at the next index creates the entry', count($item['attr']['tabs']) === 3 && $created === ['tabs.2'] && $old === '');
check('appended entry has the previous entry\'s keys', array_keys($item['attr']['tabs'][2]) === array_keys($item['attr']['tabs'][1]));
check('appended entry starts empty except the edited field', $item['attr']['tabs'][2] === ['title' => 'Phone', 'content' => '', 'icon' => '', 'image' => '']);
mfn_set_field($item, 'tabs.2.content', '+00 000 000 000', $created);
check('a second edit fills the new entry without appending again', count($item['attr']['tabs']) === 3 && $created === ['tabs.2'] && $item['attr']['tabs'][2]['content'] === '+00 000 000 000');

$before = $item;
check('skipping an index is refused', throws(function () use (&$item, &$created) { mfn_set_field($item, 'tabs.9.title', 'X', $created); }));
check('a refused skip leaves the list as it was', $item['attr']['tabs'] === $before['attr']['tabs']);
check('an unknown nested key is refused', throws(function () use (&$item, &$created) { mfn_set_field($item, 'tabs.0.nosuch', 'X', $created); }));
check('descending into a string is refused', throws(function () use (&$item, &$created) { mfn_set_field($item, 'tag.0.x', 'X', $created); }));
check('appending to an empty list is refused (no shape to copy)', throws(function () use (&$created) { $empty = ['attr' => ['tabs' => []]]; mfn_set_field($empty, 'tabs.0.title', 'X', $created); }));

$legacy = ['uid' => 'old', 'fields' => ['title' => 'A']];
check('items without attr use the fields bag', mfn_set_field($legacy, 'title', 'B', $created) === 'A' && $legacy['fields']['title'] === 'B');

check('builder data survives an encode/decode round trip', unserialize(base64_decode(mfn_encode($sections)), ['allowed_classes' => false]) === $sections);

if ($failures) { fwrite(STDERR, "FAILED:\n  " . implode("\n  ", $failures) . "\n"); exit(1); }
echo "ok {$checks} checks\n";
