<?php
/**
 * BeTheme (Muffin Builder) content helper, executed on the host via `wp eval-file`.
 *
 *   wp eval-file mfn-builder.php list  <post_id>
 *   wp eval-file mfn-builder.php get   <post_id> <uid>
 *   wp eval-file mfn-builder.php check <post_id>            # round-trip test, no write
 *   wp eval-file mfn-builder.php set   <post_id>            # STDIN: JSON [{"uid":..,"field":..,"value":..}, ...]
 *
 * Output is always a single JSON document on STDOUT.
 */
$action = $args[0] ?? '';
$postId = (int) ($args[1] ?? 0);

function mfn_out($data) { echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit(0); }
function mfn_fail($msg) { echo json_encode(['error' => $msg]); exit(1); }

function mfn_load($id) {
  $raw = get_post_meta($id, 'mfn-page-items', true);
  if (empty($raw)) return null;
  if (is_array($raw)) return $raw;
  $arr = unserialize(base64_decode($raw), ['allowed_classes' => false]);
  return is_array($arr) ? $arr : null;
}

function mfn_encode($sections) { return base64_encode(serialize($sections)); }

/** Mirror of the theme's own SEO-copy generator (Mfn_Builder_Ajax::regenerate). */
function mfn_seo_copy($sections) {
  $skip = ['#FFFFFF','{featured_image}','contain','center','center center','center top','default','disable','full','h1','h2','h3','h4','h5','h6','hide','hide-mobile','hide-tablet','horizontal','inline','left','no-repeat','none','right','show','solid','thumbnail','top','unset'];
  $out = '';
  foreach ($sections as $section) {
    foreach ($section['wraps'] ?? [] as $wrap) {
      foreach ($wrap['items'] ?? [] as $item) {
        $attr = $item['attr'] ?? ($item['fields'] ?? []);
        foreach ($attr as $k => $v) {
          if (is_string($v) && !is_numeric($v) && !in_array($v, $skip, true)) $out .= "\n" . trim($v);
          elseif ($k === 'tabs' && is_array($v)) foreach ($v as $tab) if (!empty($tab)) foreach ($tab as $f) $out .= "\n" . trim(is_string($f) ? $f : '');
        }
      }
    }
  }
  return $out;
}

function mfn_save($id, $sections) {
  update_post_meta($id, 'mfn-page-items', mfn_encode($sections));
  $seo = null;
  if (class_exists('Mfn_Builder_Admin')) {
    try { $a = new Mfn_Builder_Admin(); if (method_exists($a, 'rankMath')) $seo = $a->rankMath(false, $sections); } catch (Throwable $e) { $seo = null; }
  }
  if (!$seo) $seo = mfn_seo_copy($sections);
  update_post_meta($id, 'mfn-page-items-seo', $seo);
  // Re-save the post so post_modified is bumped and Yoast rebuilds its indexable.
  wp_update_post(['ID' => $id]);
  return strlen($seo);
}

function mfn_summarize($sections) {
  $TEXT_KEYS = ['title', 'subtitle', 'content', 'text', 'link_title', 'alt', 'description', 'caption', 'src', 'link', 'header_tag'];
  $items = [];
  foreach ($sections as $si => $section) {
    foreach ($section['wraps'] ?? [] as $wi => $wrap) {
      foreach ($wrap['items'] ?? [] as $ii => $item) {
        $attr = $item['attr'] ?? ($item['fields'] ?? []);
        $fields = [];
        foreach ($attr as $k => $v) {
          if (!is_string($v)) continue;
          if (in_array($k, $TEXT_KEYS, true) || strlen($v) > 40) $fields[$k] = $v;
        }
        $items[] = ['uid' => $item['uid'] ?? null, 'type' => $item['type'] ?? null, 'position' => "s{$si}/w{$wi}/i{$ii}", 'fields' => (object) $fields];
      }
    }
  }
  return $items;
}

function &mfn_find(&$sections, $uid) {
  foreach ($sections as &$section) {
    if (!empty($section['wraps'])) foreach ($section['wraps'] as &$wrap) {
      if (!empty($wrap['items'])) foreach ($wrap['items'] as &$item) {
        if (($item['uid'] ?? null) === $uid) return $item;
      }
    }
  }
  $null = null; return $null;
}

if (!$postId) mfn_fail('post_id required');
$sections = mfn_load($postId);
if ($sections === null) mfn_fail("post {$postId} has no Muffin Builder content (mfn-page-items empty); use wp_update_post content instead");

switch ($action) {
  case 'list':
    mfn_out(['post_id' => $postId, 'sections' => count($sections), 'items' => mfn_summarize($sections)]);
  case 'get':
    $uid = $args[2] ?? '';
    $item = mfn_find($sections, $uid);
    if ($item === null) mfn_fail("item {$uid} not found");
    mfn_out(['post_id' => $postId, 'item' => $item]);
  case 'check':
    $raw = get_post_meta($postId, 'mfn-page-items', true);
    mfn_out(['post_id' => $postId, 'roundtrip_lossless' => (is_string($raw) && mfn_encode($sections) === $raw), 'items' => count(mfn_summarize($sections))]);
  case 'set':
    $edits = json_decode(stream_get_contents(STDIN), true);
    if (!is_array($edits) || !count($edits)) mfn_fail('STDIN must be a JSON array of {uid, field, value}');
    $applied = [];
    foreach ($edits as $e) {
      $item = &mfn_find($sections, $e['uid'] ?? '');
      if ($item === null) mfn_fail("item {$e['uid']} not found");
      $bag = isset($item['attr']) ? 'attr' : 'fields';
      $old = $item[$bag][$e['field']] ?? null;
      $item[$bag][$e['field']] = (string) $e['value'];
      $applied[] = ['uid' => $e['uid'], 'field' => $e['field'], 'old_length' => is_string($old) ? strlen($old) : null, 'new_length' => strlen($e['value'])];
      unset($item);
    }
    $seoLen = mfn_save($postId, $sections);
    mfn_out(['post_id' => $postId, 'applied' => $applied, 'seo_copy_length' => $seoLen, 'post_modified' => get_post_field('post_modified', $postId)]);
  default:
    mfn_fail("unknown action '{$action}'");
}
