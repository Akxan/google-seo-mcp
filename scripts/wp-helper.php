<?php
/**
 * General WordPress/Yoast helper executed via `wp eval-file`. Input JSON on STDIN, output JSON on STDOUT.
 *   wp eval-file wp-helper.php <action>
 * Actions: post_index, seo_status, bulk_seo, media_list, media_update, terms_list, term_update,
 *          internal_links, redirects_list, redirect_add, redirect_delete
 */
$action = $args[0] ?? '';
$in = json_decode(stream_get_contents(STDIN) ?: '{}', true) ?: [];

function h_out($d) { echo json_encode($d, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit(0); }
function h_fail($m) { echo json_encode(['error' => $m]); exit(1); }

function h_yoast_rebuild($id, $type = 'post') {
  try {
    $r = YoastSEO()->classes->get(\Yoast\WP\SEO\Repositories\Indexable_Repository::class);
    $b = YoastSEO()->classes->get(\Yoast\WP\SEO\Builders\Indexable_Builder::class);
    $i = $r->find_by_id_and_type($id, $type, false);
    if ($i) $b->build($i); else $b->build_for_id_and_type($id, $type);
    return true;
  } catch (Throwable $e) { return $e->getMessage(); }
}

function h_purge($id) {
  $done = [];
  if (function_exists('rocket_clean_post')) { rocket_clean_post($id); $done[] = 'wp-rocket'; }
  if (function_exists('wp_cache_post_change')) { wp_cache_post_change($id); $done[] = 'wp-super-cache'; }
  if (function_exists('w3tc_flush_post')) { w3tc_flush_post($id); $done[] = 'w3tc'; }
  do_action('litespeed_purge_post', $id);
  return $done;
}

function h_post_text($id) {
  $t = get_post_field('post_content', $id);
  $seo = get_post_meta($id, 'mfn-page-items-seo', true);
  if ($seo) $t .= "\n" . $seo;
  return $t;
}

switch ($action) {

  case 'post_index': {
    $posts = get_posts(['post_type' => $in['postTypes'] ?? ['post', 'page'], 'post_status' => 'publish', 'posts_per_page' => -1, 'fields' => 'ids']);
    $out = [];
    foreach ($posts as $id) $out[] = ['ID' => $id, 'title' => get_the_title($id), 'url' => get_permalink($id), 'type' => get_post_type($id)];
    h_out(['home' => get_option('home'), 'posts' => $out]);
  }

  case 'seo_status': {
    $posts = get_posts(['post_type' => $in['postTypes'] ?? ['post', 'page'], 'post_status' => $in['status'] ?? 'publish', 'posts_per_page' => -1, 'orderby' => 'date', 'order' => 'DESC']);
    $out = [];
    foreach ($posts as $p) {
      $title = get_post_meta($p->ID, '_yoast_wpseo_title', true);
      $desc = get_post_meta($p->ID, '_yoast_wpseo_metadesc', true);
      $kw = get_post_meta($p->ID, '_yoast_wpseo_focuskw', true);
      $noindex = get_post_meta($p->ID, '_yoast_wpseo_meta-robots-noindex', true);
      $words = str_word_count(strip_tags(h_post_text($p->ID)));
      $row = [
        'ID' => $p->ID, 'type' => $p->post_type, 'title' => $p->post_title, 'url' => get_permalink($p),
        'modified' => $p->post_modified, 'words' => $words,
        'seoTitle' => $title, 'seoTitleLength' => mb_strlen($title),
        'metaDescription' => $desc, 'metaDescriptionLength' => mb_strlen($desc),
        'focusKeyword' => $kw, 'noindex' => $noindex === '1',
        'missing' => array_values(array_filter([ $title === '' ? 'seoTitle' : null, $desc === '' ? 'metaDescription' : null, $kw === '' ? 'focusKeyword' : null ])),
      ];
      if (!empty($in['missingOnly']) && !count($row['missing'])) continue;
      $out[] = $row;
    }
    h_out(['count' => count($out), 'posts' => $out]);
  }

  case 'bulk_seo': {
    $keys = ['seoTitle' => '_yoast_wpseo_title', 'metaDescription' => '_yoast_wpseo_metadesc', 'focusKeyword' => '_yoast_wpseo_focuskw', 'canonical' => '_yoast_wpseo_canonical'];
    $results = [];
    foreach ($in['items'] ?? [] as $it) {
      $id = (int) ($it['id'] ?? 0);
      if (!$id || !get_post($id)) { $results[] = ['id' => $id, 'error' => 'post not found']; continue; }
      $updated = [];
      foreach ($keys as $field => $meta) {
        if (!array_key_exists($field, $it)) continue;
        if ($it[$field] === '' || $it[$field] === null) delete_post_meta($id, $meta); else update_post_meta($id, $meta, (string) $it[$field]);
        $updated[] = $field;
      }
      if (array_key_exists('noindex', $it)) {
        if ($it['noindex'] === null) delete_post_meta($id, '_yoast_wpseo_meta-robots-noindex'); else update_post_meta($id, '_yoast_wpseo_meta-robots-noindex', $it['noindex'] ? '1' : '2');
        $updated[] = 'noindex';
      }
      $results[] = ['id' => $id, 'title' => get_the_title($id), 'updated' => $updated, 'indexable' => h_yoast_rebuild($id), 'purged' => h_purge($id)];
    }
    h_out(['results' => $results]);
  }

  case 'media_list': {
    $q = ['post_type' => 'attachment', 'post_status' => 'inherit', 'post_mime_type' => 'image', 'posts_per_page' => (int) ($in['perPage'] ?? 50), 'paged' => (int) ($in['page'] ?? 1), 'orderby' => 'date', 'order' => 'DESC'];
    if (!empty($in['search'])) $q['s'] = $in['search'];
    if (!empty($in['attachedTo'])) $q['post_parent'] = (int) $in['attachedTo'];
    if (!empty($in['missingAltOnly'])) { $q['posts_per_page'] = -1; $q['paged'] = 1; }
    $items = get_posts($q);
    $out = [];
    foreach ($items as $m) {
      $alt = get_post_meta($m->ID, '_wp_attachment_image_alt', true);
      if (!empty($in['missingAltOnly']) && trim($alt) !== '') continue;
      $meta = wp_get_attachment_metadata($m->ID);
      $out[] = ['ID' => $m->ID, 'title' => $m->post_title, 'alt' => $alt, 'caption' => $m->post_excerpt, 'url' => wp_get_attachment_url($m->ID), 'width' => $meta['width'] ?? null, 'height' => $meta['height'] ?? null, 'sizeKB' => isset($meta['filesize']) ? round($meta['filesize'] / 1024) : null, 'attachedTo' => $m->post_parent ?: null, 'attachedTitle' => $m->post_parent ? get_the_title($m->post_parent) : null, 'date' => $m->post_date];
      if (!empty($in['missingAltOnly']) && count($out) >= (int) ($in['perPage'] ?? 50)) break;
    }
    h_out(['count' => count($out), 'media' => $out]);
  }

  case 'media_update': {
    $results = [];
    foreach ($in['items'] ?? [] as $it) {
      $id = (int) ($it['id'] ?? 0);
      if (!$id || get_post_type($id) !== 'attachment') { $results[] = ['id' => $id, 'error' => 'attachment not found']; continue; }
      $u = ['ID' => $id];
      if (isset($it['alt'])) update_post_meta($id, '_wp_attachment_image_alt', (string) $it['alt']);
      if (isset($it['title'])) $u['post_title'] = $it['title'];
      if (isset($it['caption'])) $u['post_excerpt'] = $it['caption'];
      if (isset($it['description'])) $u['post_content'] = $it['description'];
      if (count($u) > 1) wp_update_post($u);
      $results[] = ['id' => $id, 'alt' => get_post_meta($id, '_wp_attachment_image_alt', true), 'title' => get_the_title($id)];
    }
    h_out(['results' => $results]);
  }

  case 'terms_list': {
    $tax = $in['taxonomy'] ?? 'category';
    $terms = get_terms(['taxonomy' => $tax, 'hide_empty' => false, 'search' => $in['search'] ?? '']);
    if (is_wp_error($terms)) h_fail($terms->get_error_message());
    $ym = get_option('wpseo_taxonomy_meta') ?: [];
    $out = [];
    foreach ($terms as $t) {
      $m = $ym[$tax][$t->term_id] ?? [];
      $out[] = ['id' => $t->term_id, 'name' => $t->name, 'slug' => $t->slug, 'count' => $t->count, 'parent' => $t->parent ?: null, 'description' => $t->description, 'url' => get_term_link($t), 'seoTitle' => $m['wpseo_title'] ?? '', 'metaDescription' => $m['wpseo_desc'] ?? '', 'noindex' => ($m['wpseo_noindex'] ?? '') === 'noindex'];
    }
    h_out(['taxonomy' => $tax, 'count' => count($out), 'terms' => $out]);
  }

  case 'term_update': {
    $tax = $in['taxonomy'] ?? 'category';
    $id = (int) ($in['id'] ?? 0);
    $t = get_term($id, $tax);
    if (!$t || is_wp_error($t)) h_fail("term {$id} not found in {$tax}");
    $u = [];
    foreach (['name', 'slug', 'description'] as $k) if (isset($in[$k])) $u[$k] = $in[$k];
    if ($u) { $r = wp_update_term($id, $tax, $u); if (is_wp_error($r)) h_fail($r->get_error_message()); }
    if (isset($in['seoTitle']) || isset($in['metaDescription']) || array_key_exists('noindex', $in)) {
      $ym = get_option('wpseo_taxonomy_meta') ?: [];
      if (isset($in['seoTitle'])) $ym[$tax][$id]['wpseo_title'] = $in['seoTitle'];
      if (isset($in['metaDescription'])) $ym[$tax][$id]['wpseo_desc'] = $in['metaDescription'];
      if (array_key_exists('noindex', $in)) $ym[$tax][$id]['wpseo_noindex'] = $in['noindex'] === true ? 'noindex' : ($in['noindex'] === false ? 'index' : 'default');
      update_option('wpseo_taxonomy_meta', $ym);
    }
    $indexable = h_yoast_rebuild($id, 'term');
    if (function_exists('rocket_clean_term')) rocket_clean_term($id, $tax);
    $t = get_term($id, $tax);
    h_out(['id' => $id, 'name' => $t->name, 'slug' => $t->slug, 'url' => get_term_link($t), 'indexable' => $indexable]);
  }

  case 'internal_links': {
    $target = (int) ($in['targetId'] ?? 0);
    $keywords = array_values(array_filter(array_map('trim', $in['keywords'] ?? [])));
    if (!$target || !$keywords) h_fail('targetId and keywords required');
    $targetUrl = get_permalink($target);
    $targetPath = rtrim(parse_url($targetUrl, PHP_URL_PATH) ?? '', '/');
    $posts = get_posts(['post_type' => $in['postTypes'] ?? ['post', 'page'], 'post_status' => 'publish', 'posts_per_page' => -1, 'exclude' => [$target]]);
    $out = [];
    foreach ($posts as $p) {
      $raw = get_post_field('post_content', $p->ID);
      $builder = get_post_meta($p->ID, 'mfn-page-items', true);
      $builderTxt = is_string($builder) ? base64_decode($builder) : '';
      $already = (stripos($raw, $targetPath . '/') !== false) || (stripos($raw, $targetUrl) !== false) || ($builderTxt && stripos($builderTxt, $targetPath) !== false);
      $text = strip_tags(h_post_text($p->ID));
      $matches = [];
      $total = 0;
      foreach ($keywords as $kw) { $c = mb_substr_count(mb_strtolower($text), mb_strtolower($kw)); if ($c) { $matches[$kw] = $c; $total += $c; } }
      if (!$total) continue;
      // one snippet around the first keyword hit
      $snippet = '';
      foreach ($keywords as $kw) { $pos = mb_stripos($text, $kw); if ($pos !== false) { $snippet = trim(mb_substr($text, max(0, $pos - 80), 200)); break; } }
      $out[] = ['ID' => $p->ID, 'title' => $p->post_title, 'url' => get_permalink($p), 'type' => $p->post_type, 'matches' => $matches, 'totalMatches' => $total, 'alreadyLinksToTarget' => $already, 'snippet' => $snippet];
    }
    usort($out, fn($a, $b) => [$a['alreadyLinksToTarget'], -$a['totalMatches']] <=> [$b['alreadyLinksToTarget'], -$b['totalMatches']]);
    h_out(['target' => ['ID' => $target, 'title' => get_the_title($target), 'url' => $targetUrl], 'keywords' => $keywords, 'candidates' => array_slice($out, 0, (int) ($in['limit'] ?? 30))]);
  }

  case 'redirects_list': {
    if (!class_exists('WPSEO_Redirect_Manager')) h_fail('Yoast SEO Premium redirect manager not available');
    $out = [];
    foreach (['plain', 'regex'] as $fmt) {
      $m = new WPSEO_Redirect_Manager($fmt);
      foreach ($m->get_redirects() as $r) $out[] = ['origin' => $r->get_origin(), 'target' => $r->get_target(), 'type' => $r->get_type(), 'format' => $fmt];
    }
    if (!empty($in['search'])) { $s = mb_strtolower($in['search']); $out = array_values(array_filter($out, fn($r) => str_contains(mb_strtolower($r['origin'] . ' ' . $r['target']), $s))); }
    h_out(['count' => count($out), 'redirects' => $out]);
  }

  case 'redirect_add': {
    if (!class_exists('WPSEO_Redirect_Manager')) h_fail('Yoast SEO Premium redirect manager not available');
    $fmt = $in['format'] ?? 'plain';
    $type = (int) ($in['type'] ?? 301);
    $redirect = new WPSEO_Redirect($in['origin'], $in['target'] ?? '', $type, $fmt);
    $m = new WPSEO_Redirect_Manager($fmt);
    foreach ($m->get_redirects() as $r) if ($r->get_origin() === $redirect->get_origin()) h_fail("a redirect for origin '{$redirect->get_origin()}' already exists -> {$r->get_target()}");
    $ok = $m->create_redirect($redirect);
    if (!$ok) h_fail('Yoast refused the redirect (validation failed; check origin/target)');
    h_out(['created' => true, 'origin' => $redirect->get_origin(), 'target' => $redirect->get_target(), 'type' => $type, 'format' => $fmt]);
  }

  case 'redirect_delete': {
    if (!class_exists('WPSEO_Redirect_Manager')) h_fail('Yoast SEO Premium redirect manager not available');
    $fmt = $in['format'] ?? 'plain';
    $m = new WPSEO_Redirect_Manager($fmt);
    $probe = new WPSEO_Redirect($in['origin'], '', 301, $fmt);
    foreach ($m->get_redirects() as $r) {
      if ($r->get_origin() === $probe->get_origin()) { $m->delete_redirects([$r]); h_out(['deleted' => true, 'origin' => $r->get_origin(), 'target' => $r->get_target()]); }
    }
    h_fail("no redirect with origin '{$probe->get_origin()}'");
  }

  case 'schema_get': {
    $id = (int) ($in['id'] ?? 0);
    $json = get_post_meta($id, '_seo_mcp_schema', true);
    h_out(['id' => $id, 'schema' => $json ? json_decode($json, true) : null, 'muPluginInstalled' => file_exists(WPMU_PLUGIN_DIR . '/seo-mcp-schema.php')]);
  }

  case 'schema_set': {
    $id = (int) ($in['id'] ?? 0);
    if (!$id || !get_post($id)) h_fail("post {$id} not found");
    $plugin = WPMU_PLUGIN_DIR . '/seo-mcp-schema.php';
    if (!file_exists($plugin)) {
      if (!is_dir(WPMU_PLUGIN_DIR)) mkdir(WPMU_PLUGIN_DIR, 0755, true);
      $code = "<?php\n/**\n * Plugin Name: SEO MCP Schema\n * Description: Outputs JSON-LD stored in the _seo_mcp_schema post meta (managed by google-seo-mcp).\n * Version: 1.0\n */\nadd_action('wp_head', function () {\n  if (!is_singular()) return;\n  \$json = get_post_meta(get_queried_object_id(), '_seo_mcp_schema', true);\n  if (!\$json) return;\n  echo \"\\n<script type=\\\"application/ld+json\\\" class=\\\"seo-mcp-schema\\\">\" . \$json . \"</script>\\n\";\n}, 99);\n";
      if (file_put_contents($plugin, $code) === false) h_fail('could not write mu-plugin ' . $plugin);
    }
    if (empty($in['jsonld'])) { delete_post_meta($id, '_seo_mcp_schema'); $stored = null; }
    else { $stored = json_encode($in['jsonld'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); update_post_meta($id, '_seo_mcp_schema', wp_slash($stored)); }
    h_out(['id' => $id, 'url' => get_permalink($id), 'stored' => $stored ? json_decode($stored, true) : null, 'bytes' => $stored ? strlen($stored) : 0, 'muPlugin' => $plugin, 'purged' => h_purge($id)]);
  }

  default:
    h_fail("unknown action '{$action}'");
}
