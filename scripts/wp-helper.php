<?php
/**
 * General WordPress/Yoast helper executed via `wp eval-file`. Input JSON on STDIN, output JSON on STDOUT.
 *   wp eval-file wp-helper.php <action>
 * Actions: post_index, seo_status, bulk_seo, media_list, media_update, terms_list, term_update,
 *          internal_links, redirects_list, redirect_add, redirect_delete, schema_get, schema_set,
 *          seo_settings_get, seo_settings_set, revisions_list, revision_restore, purge_site
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

/** Clear every cached page on the site (not just one post), whichever cache plugin is installed. */
function h_purge_site() {
  $done = [];
  if (function_exists('rocket_clean_domain')) { rocket_clean_domain(); $done[] = 'wp-rocket'; }
  if (function_exists('rocket_clean_minify')) { rocket_clean_minify(); $done[] = 'wp-rocket-minify'; }
  if (function_exists('wp_cache_clear_cache')) { wp_cache_clear_cache(); $done[] = 'wp-super-cache'; }
  if (function_exists('w3tc_flush_all')) { w3tc_flush_all(); $done[] = 'w3tc'; }
  do_action('litespeed_purge_all');
  return $done ?: ['none'];
}

/** Clear WP Rocket's "Remove Unused CSS" results, the same call as its "Clear Used CSS" button.
    That trimmed stylesheet is computed once per URL from the HTML of the day and stored apart
    from the page cache, so a page purge leaves it alone: after a header/footer/theme change it
    keeps dropping rules for classes that did not exist yet (a footer phone icon once stayed
    invisible on every page because the trimmed CSS was months old). Pages load the full CSS until
    WP Rocket rebuilds them. */
function h_clear_used_css() {
  $opts = get_option('wp_rocket_settings');
  if (empty($opts['remove_unused_css'])) return 'not enabled';
  $c = apply_filters('rocket_container', null);
  if (!is_object($c) || !method_exists($c, 'get')) return 'wp-rocket container unavailable';
  try {
    $sub = $c->get('rucss_admin_subscriber');
    if (!method_exists($sub, 'delete_used_css_rows')) return 'unsupported wp-rocket version';
    $sub->delete_used_css_rows();
    return 'wp-rocket used css cleared';
  } catch (Throwable $e) { return 'failed: ' . $e->getMessage(); }
}

/** Drop Yoast's cached XML sitemaps so the next fetch is built from current data. */
function h_flush_yoast_sitemap() {
  $done = [];
  if (class_exists('WPSEO_Sitemaps_Cache')) {
    try {
      WPSEO_Sitemaps_Cache::clear();
      if (method_exists('WPSEO_Sitemaps_Cache', 'clear_queued')) WPSEO_Sitemaps_Cache::clear_queued();
      $done[] = 'wpseo-sitemaps-cache';
    } catch (Throwable $e) { $done[] = 'cache class failed: ' . $e->getMessage(); }
  }
  $wpdb = $GLOBALS['wpdb'] ?? null;
  if ($wpdb) {
    // The cache class only queues what it knows about; the transients themselves are the source of truth.
    $n = $wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE '\\_transient\\_yst\\_sm%' OR option_name LIKE '\\_transient\\_timeout\\_yst\\_sm%' OR option_name LIKE '\\_transient\\_wpseo\\_sitemap%' OR option_name LIKE '\\_transient\\_timeout\\_wpseo\\_sitemap%'");
    $done[] = "transients deleted: " . (int) $n;
  }
  return $done;
}

/** One Yoast setting with its default applied, whichever option group it lives in. */
function h_yo($key, $default = '') {
  static $all = null;
  if ($all === null) {
    $all = [];
    if (class_exists('WPSEO_Options')) { try { $all = WPSEO_Options::get_all(); } catch (Throwable $e) { $all = []; } }
    if (!$all) $all = array_merge(get_option('wpseo') ?: [], get_option('wpseo_titles') ?: [], get_option('wpseo_social') ?: []);
  }
  return array_key_exists($key, $all) ? $all[$key] : $default;
}

/** Yoast 20+ builds an organization's sameAs from facebook_site, twitter_site and the
    other_social_urls list only (Social_Profiles_Helper::get_organization_social_profile_fields);
    instagram_url, youtube_url and the like are legacy keys it never reads for an organization.
    So named platforms are kept inside other_social_urls, one URL each. */
function h_social_platforms() {
  return ['instagram' => ['instagram.com'], 'linkedin' => ['linkedin.com'], 'youtube' => ['youtube.com', 'youtu.be'], 'pinterest' => ['pinterest.'], 'wikipedia' => ['wikipedia.org']];
}
function h_social_platform($url) {
  $host = strtolower((string) parse_url((string) $url, PHP_URL_HOST));
  if ($host === '') return null;
  foreach (h_social_platforms() as $name => $needles) foreach ($needles as $n) if (strpos($host, $n) !== false) return $name;
  return null;
}
/** Split other_social_urls into [platform => url] (first URL per platform) and the unnamed rest. */
function h_split_social($urls) {
  $named = []; $rest = [];
  foreach ((array) $urls as $u) { $p = h_social_platform($u); if ($p !== null && !isset($named[$p])) $named[$p] = $u; else $rest[] = $u; }
  return [$named, $rest];
}

/** Line-level difference between two texts: counts plus a bounded sample, so a diff cannot flood the result. */
function h_diff_lines($before, $after, $max = 15) {
  $a = preg_split("/\r\n|\n|\r/", (string) $before);
  $b = preg_split("/\r\n|\n|\r/", (string) $after);
  $removed = array_values(array_diff($a, $b));
  $added = array_values(array_diff($b, $a));
  $cut = fn($lines) => array_values(array_map(fn($l) => mb_substr(trim($l), 0, 160), array_slice($lines, 0, $max)));
  return [
    'identical' => (string) $before === (string) $after,
    'charsFrom' => mb_strlen((string) $before), 'charsTo' => mb_strlen((string) $after),
    'linesRemoved' => count($removed), 'linesAdded' => count($added),
    'sampleRemoved' => $cut($removed), 'sampleAdded' => $cut($added),
  ];
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
    $dry = !empty($in['dryRun']);
    foreach ($in['items'] ?? [] as $it) {
      $id = (int) ($it['id'] ?? 0);
      if (!$id || !get_post($id)) { $results[] = ['id' => $id, 'error' => 'post not found']; continue; }
      if ($dry) {
        $changes = [];
        foreach ($keys as $field => $meta) if (array_key_exists($field, $it)) $changes[] = ['field' => $field, 'from' => get_post_meta($id, $meta, true), 'to' => $it[$field]];
        if (array_key_exists('noindex', $it)) $changes[] = ['field' => 'noindex', 'from' => get_post_meta($id, '_yoast_wpseo_meta-robots-noindex', true), 'to' => $it['noindex']];
        $results[] = ['id' => $id, 'title' => get_the_title($id), 'dryRun' => true, 'changes' => $changes];
        continue;
      }
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
    $q = ['post_type' => 'attachment', 'post_status' => 'inherit', 'posts_per_page' => (int) ($in['perPage'] ?? 50), 'paged' => (int) ($in['page'] ?? 1), 'orderby' => 'date', 'order' => 'DESC'];
    $mime = trim((string) ($in['mimeType'] ?? 'image'));
    if ($mime !== '' && strtolower($mime) !== 'any') $q['post_mime_type'] = $mime;
    if (!empty($in['search'])) $q['s'] = $in['search'];
    if (!empty($in['attachedTo'])) $q['post_parent'] = (int) $in['attachedTo'];
    $perPage = max(1, (int) ($in['perPage'] ?? 50));
    $page = max(1, (int) ($in['page'] ?? 1));
    $missingOnly = !empty($in['missingAltOnly']);
    // Alt text lives in postmeta, so "missing alt" cannot be a WP_Query condition:
    // load every attachment and page through the matches by hand.
    if ($missingOnly) { $q['posts_per_page'] = -1; $q['paged'] = 1; }
    $items = get_posts($q);
    $out = [];
    $matched = 0;
    $offset = $missingOnly ? ($page - 1) * $perPage : 0;
    foreach ($items as $m) {
      $alt = get_post_meta($m->ID, '_wp_attachment_image_alt', true);
      if ($missingOnly && trim($alt) !== '') continue;
      $matched++;
      if ($matched <= $offset) continue;            // earlier page
      if ($missingOnly && count($out) >= $perPage) continue;  // keep counting for the total
      $meta = wp_get_attachment_metadata($m->ID);
      $bytes = $meta['filesize'] ?? null;
      if ($bytes === null) { $f = get_attached_file($m->ID); if ($f && file_exists($f)) $bytes = filesize($f); }
      $out[] = ['ID' => $m->ID, 'title' => $m->post_title, 'mime' => $m->post_mime_type, 'alt' => $alt, 'caption' => $m->post_excerpt, 'url' => wp_get_attachment_url($m->ID), 'width' => $meta['width'] ?? null, 'height' => $meta['height'] ?? null, 'sizeKB' => $bytes ? round($bytes / 1024) : null, 'attachedTo' => $m->post_parent ?: null, 'attachedTitle' => $m->post_parent ? get_the_title($m->post_parent) : null, 'date' => $m->post_date];
    }
    $res = ['count' => count($out), 'page' => $page, 'perPage' => $perPage, 'mimeType' => $mime, 'media' => $out];
    if ($missingOnly) {
      $res['totalMissingAlt'] = $matched;
      $res['pages'] = (int) ceil($matched / $perPage);
      $res['hasMore'] = $matched > $page * $perPage;
    }
    h_out($res);
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

  case 'seo_settings_get': {
    if (!defined('WPSEO_VERSION')) h_fail('Yoast SEO is not active on this site');
    $types = [];
    foreach (get_post_types(['public' => true], 'objects') as $pt) {
      $counts = wp_count_posts($pt->name);
      $types[] = [
        'for' => $pt->name, 'label' => $pt->label, 'published' => (int) ($counts->publish ?? 0),
        'title' => h_yo('title-' . $pt->name), 'metaDescription' => h_yo('metadesc-' . $pt->name),
        'noindex' => (bool) h_yo('noindex-' . $pt->name, false), 'inSitemap' => !h_yo('noindex-' . $pt->name, false),
        'schemaPageType' => h_yo('schema-page-type-' . $pt->name, null), 'schemaArticleType' => h_yo('schema-article-type-' . $pt->name, null),
      ];
    }
    $taxes = [];
    foreach (get_taxonomies(['public' => true], 'objects') as $tx) {
      $ids = get_terms(['taxonomy' => $tx->name, 'hide_empty' => false, 'fields' => 'ids']);
      $taxes[] = [
        'for' => 'tax-' . $tx->name, 'label' => $tx->label, 'terms' => is_array($ids) ? count($ids) : 0,
        'title' => h_yo('title-tax-' . $tx->name), 'metaDescription' => h_yo('metadesc-tax-' . $tx->name),
        'noindex' => (bool) h_yo('noindex-tax-' . $tx->name, false), 'inSitemap' => !h_yo('noindex-tax-' . $tx->name, false),
      ];
    }
    $archives = [
      'author' => ['for' => 'author-wpseo', 'disabled' => (bool) h_yo('disable-author', false), 'noindex' => (bool) h_yo('noindex-author-wpseo', false), 'noindexWithoutPosts' => (bool) h_yo('noindex-author-noposts-wpseo', false), 'title' => h_yo('title-author-wpseo'), 'metaDescription' => h_yo('metadesc-author-wpseo')],
      'date' => ['for' => 'archive-wpseo', 'disabled' => (bool) h_yo('disable-date', false), 'noindex' => (bool) h_yo('noindex-archive-wpseo', false), 'title' => h_yo('title-archive-wpseo'), 'metaDescription' => h_yo('metadesc-archive-wpseo')],
      'postFormat' => ['disabled' => (bool) h_yo('disable-post_format', false)],
      'attachmentPagesRedirected' => (bool) h_yo('disable-attachment', true),
      'search' => ['for' => 'search-wpseo', 'title' => h_yo('title-search-wpseo')],
      'notFound' => ['for' => '404-wpseo', 'title' => h_yo('title-404-wpseo')],
    ];
    $breadcrumbs = [
      'enabled' => (bool) h_yo('breadcrumbs-enable', false), 'separator' => h_yo('breadcrumbs-sep'), 'homeText' => h_yo('breadcrumbs-home'),
      'prefix' => h_yo('breadcrumbs-prefix'), 'archivePrefix' => h_yo('breadcrumbs-archiveprefix'), 'searchPrefix' => h_yo('breadcrumbs-searchprefix'),
      'notFoundText' => h_yo('breadcrumbs-404crumb'), 'boldLast' => (bool) h_yo('breadcrumbs-boldlast', false), 'taxonomyForPosts' => h_yo('breadcrumbs-taxonomy-post'),
    ];
    $personId = (int) h_yo('company_or_person_user_id', 0);
    $organization = [
      'type' => h_yo('company_or_person'), 'name' => h_yo('company_name'), 'alternateName' => h_yo('company_alternate_name'),
      'logoId' => ((int) h_yo('company_logo_id', 0)) ?: null, 'logo' => h_yo('company_logo'),
      'personUserId' => $personId ?: null, 'personName' => $personId ? get_the_author_meta('display_name', $personId) : null,
      'websiteName' => h_yo('website_name'), 'alternateWebsiteName' => h_yo('alternate_website_name'),
      'email' => h_yo('org-email'), 'phone' => h_yo('org-phone'),
    ];
    [$named, $rest] = h_split_social(h_yo('other_social_urls', []));
    $social = ['facebook' => h_yo('facebook_site'), 'twitter' => h_yo('twitter_site')];
    foreach (array_keys(h_social_platforms()) as $f) $social[$f] = $named[$f] ?? '';
    $social['other'] = $rest;
    // Values left in the legacy per-platform options are not published; say so instead of reporting them.
    $legacy = [];
    foreach (array_keys(h_social_platforms()) as $f) { $v = (string) h_yo("{$f}_url"); if ($v !== '') $legacy[$f] = $v; }
    if ($legacy) $social['legacyIgnored'] = $legacy;
    $excluded = array_values(array_merge(
      array_map(fn($x) => $x['for'], array_filter($types, fn($x) => $x['noindex'])),
      array_map(fn($x) => $x['for'], array_filter($taxes, fn($x) => $x['noindex']))
    ));
    $res = [
      'yoastVersion' => WPSEO_VERSION, 'separator' => h_yo('separator'),
      'postTypes' => $types, 'taxonomies' => $taxes, 'archives' => $archives, 'breadcrumbs' => $breadcrumbs,
      'organization' => $organization, 'socialProfiles' => $social,
      'sitemap' => ['enabled' => (bool) h_yo('enable_xml_sitemap', true), 'url' => rtrim(get_option('home'), '/') . '/sitemap_index.xml', 'excludedTypes' => $excluded],
    ];
    if (!empty($in['raw'])) { $res['rawTitles'] = get_option('wpseo_titles') ?: []; $res['rawSocial'] = get_option('wpseo_social') ?: []; $res['rawGeneral'] = get_option('wpseo') ?: []; }
    h_out($res);
  }

  case 'seo_settings_set': {
    if (!defined('WPSEO_VERSION')) h_fail('Yoast SEO is not active on this site');
    $dry = array_key_exists('dryRun', $in) ? (bool) $in['dryRun'] : true;
    $titles = get_option('wpseo_titles') ?: [];
    $social = get_option('wpseo_social') ?: [];
    $general = get_option('wpseo') ?: [];
    $titles0 = $titles; $social0 = $social; $general0 = $general;
    $changes = [];
    $same = function ($a, $b) {
      if (is_bool($a) || is_bool($b)) return (bool) $a === (bool) $b;
      if (is_array($a) || is_array($b)) return $a === $b;
      return (string) $a === (string) $b;
    };
    $set = function (&$opt, $key, $value, $label) use (&$changes, $same) {
      $from = h_yo($key, null);
      if ($same($from, $value)) return;
      $changes[] = ['setting' => $label, 'key' => $key, 'from' => $from, 'to' => $value];
      $opt[$key] = $value;
    };

    $allowed = [];
    foreach (get_post_types(['public' => true], 'objects') as $pt) $allowed[] = $pt->name;
    foreach (get_taxonomies(['public' => true], 'objects') as $tx) $allowed[] = 'tax-' . $tx->name;
    foreach (['author-wpseo', 'archive-wpseo', 'search-wpseo', '404-wpseo'] as $k) $allowed[] = $k;
    foreach ($in['templates'] ?? [] as $tpl) {
      $for = (string) ($tpl['for'] ?? '');
      if (!in_array($for, $allowed, true)) h_fail("unknown template target '{$for}'; valid targets: " . implode(', ', $allowed));
      if (array_key_exists('title', $tpl)) $set($titles, 'title-' . $for, (string) $tpl['title'], "title template of {$for}");
      if (array_key_exists('metaDescription', $tpl)) $set($titles, 'metadesc-' . $for, (string) $tpl['metaDescription'], "meta description template of {$for}");
      if (array_key_exists('noindex', $tpl)) {
        if (in_array($for, ['search-wpseo', '404-wpseo'], true)) h_fail("'{$for}' has no noindex switch: Yoast always noindexes it");
        $set($titles, 'noindex-' . $for, (bool) $tpl['noindex'], "noindex of {$for} (also removes it from the XML sitemap)");
      }
    }

    $arch = $in['archives'] ?? [];
    if (array_key_exists('disableAuthor', $arch)) $set($titles, 'disable-author', (bool) $arch['disableAuthor'], 'author archives disabled');
    if (array_key_exists('disableDate', $arch)) $set($titles, 'disable-date', (bool) $arch['disableDate'], 'date archives disabled');
    if (array_key_exists('disableFormat', $arch)) $set($titles, 'disable-post_format', (bool) $arch['disableFormat'], 'post format archives disabled');
    if (array_key_exists('disableAttachmentPages', $arch)) $set($titles, 'disable-attachment', (bool) $arch['disableAttachmentPages'], 'attachment pages redirected to the file');
    if (array_key_exists('separator', $in)) $set($titles, 'separator', (string) $in['separator'], 'title separator');

    $bcMap = ['enabled' => ['breadcrumbs-enable', 'bool'], 'separator' => ['breadcrumbs-sep', 'str'], 'homeText' => ['breadcrumbs-home', 'str'], 'prefix' => ['breadcrumbs-prefix', 'str'], 'archivePrefix' => ['breadcrumbs-archiveprefix', 'str'], 'searchPrefix' => ['breadcrumbs-searchprefix', 'str'], 'notFoundText' => ['breadcrumbs-404crumb', 'str'], 'boldLast' => ['breadcrumbs-boldlast', 'bool'], 'taxonomyForPosts' => ['breadcrumbs-taxonomy-post', 'str']];
    $bc = $in['breadcrumbs'] ?? [];
    foreach ($bcMap as $field => $spec) {
      if (!array_key_exists($field, $bc)) continue;
      $set($titles, $spec[0], $spec[1] === 'bool' ? (bool) $bc[$field] : (string) $bc[$field], "breadcrumbs {$field}");
    }

    $org = $in['organization'] ?? [];
    if (array_key_exists('type', $org)) $set($titles, 'company_or_person', $org['type'] === 'person' ? 'person' : 'company', 'knowledge graph entity type');
    if (array_key_exists('name', $org)) $set($titles, 'company_name', (string) $org['name'], 'organization name');
    if (array_key_exists('alternateName', $org)) $set($titles, 'company_alternate_name', (string) $org['alternateName'], 'organization alternate name');
    if (array_key_exists('logoId', $org)) {
      $lid = (int) $org['logoId'];
      if (get_post_type($lid) !== 'attachment') h_fail("logoId {$lid} is not an attachment");
      $set($titles, 'company_logo_id', $lid, 'organization logo id');
      $set($titles, 'company_logo', (string) wp_get_attachment_url($lid), 'organization logo url');
    }
    if (array_key_exists('personUserId', $org)) {
      $uid = (int) $org['personUserId'];
      if (!get_userdata($uid)) h_fail("personUserId {$uid} is not a WordPress user");
      $set($titles, 'company_or_person_user_id', $uid, 'person behind the site');
    }
    if (array_key_exists('websiteName', $org)) $set($titles, 'website_name', (string) $org['websiteName'], 'website name in schema');
    if (array_key_exists('alternateWebsiteName', $org)) $set($titles, 'alternate_website_name', (string) $org['alternateWebsiteName'], 'alternate website name in schema');
    // Yoast 21+ publishes these as the Organization's email and telephone in its schema graph.
    if (array_key_exists('email', $org)) {
      $mail = trim((string) $org['email']);
      if ($mail !== '' && !is_email($mail)) h_fail("email '{$mail}' is not a valid address");
      $set($titles, 'org-email', $mail, 'organization email (schema)');
    }
    if (array_key_exists('phone', $org)) $set($titles, 'org-phone', trim((string) $org['phone']), 'organization telephone (schema)');

    $prof = $in['socialProfiles'] ?? [];
    foreach (['facebook' => 'facebook_site', 'twitter' => 'twitter_site'] as $field => $key) if (array_key_exists($field, $prof)) $set($social, $key, (string) $prof[$field], "social profile {$field}");
    [$named, $rest] = h_split_social(h_yo('other_social_urls', []));
    $touched = false;
    if (array_key_exists('other', $prof)) { $rest = array_values(array_filter(array_map('esc_url_raw', (array) $prof['other']))); $touched = true; }
    foreach (array_keys(h_social_platforms()) as $field) {
      if (!array_key_exists($field, $prof)) continue;
      $url = esc_url_raw(trim((string) $prof[$field]));
      if ($url === '') unset($named[$field]); else $named[$field] = $url;
      $touched = true;
      // Clear the legacy option too: a value Yoast ignores only misleads whoever reads it next.
      if ((string) h_yo("{$field}_url") !== '') $set($social, "{$field}_url", '', "legacy {$field} option (Yoast 20+ does not publish it)");
    }
    if ($touched) $set($social, 'other_social_urls', array_values(array_unique(array_merge(array_values($named), $rest))), 'other social profiles (sameAs)');

    if (array_key_exists('xmlSitemap', $in)) $set($general, 'enable_xml_sitemap', (bool) $in['xmlSitemap'], 'XML sitemap enabled');

    if (!$changes) h_out(['dryRun' => $dry, 'changes' => [], 'note' => 'Every value already matches the current settings; nothing to write.']);
    if ($dry) h_out(['dryRun' => true, 'changes' => $changes, 'note' => 'Nothing was written. Call again with dryRun=false to apply.']);
    if ($titles !== $titles0) update_option('wpseo_titles', $titles);
    if ($social !== $social0) update_option('wpseo_social', $social);
    if ($general !== $general0) update_option('wpseo', $general);
    h_out(['dryRun' => false, 'changes' => $changes, 'flushed' => ['yoastSitemap' => h_flush_yoast_sitemap(), 'pageCache' => h_purge_site()], 'note' => 'Yoast validates and normalises these options on save; re-read with wp_get_seo_settings to confirm what was stored.']);
  }

  case 'revisions_list': {
    $id = (int) ($in['id'] ?? 0);
    $post = get_post($id);
    if (!$post) h_fail("post {$id} not found");
    $limit = max(1, min(50, (int) ($in['limit'] ?? 20)));
    $revs = wp_get_post_revisions($id, ['posts_per_page' => $limit, 'orderby' => 'date', 'order' => 'DESC']);
    $out = [];
    foreach ($revs as $r) {
      $out[] = [
        'revisionId' => $r->ID, 'date' => $r->post_date, 'author' => get_the_author_meta('display_name', $r->post_author),
        'autosave' => (bool) wp_is_post_autosave($r->ID), 'title' => $r->post_title,
        'titleDiffers' => (string) $r->post_title !== (string) $post->post_title,
        'contentChars' => mb_strlen((string) $r->post_content),
        'contentCharsDelta' => mb_strlen((string) $r->post_content) - mb_strlen((string) $post->post_content),
        'excerptDiffers' => (string) $r->post_excerpt !== (string) $post->post_excerpt,
      ];
    }
    $builder = get_post_meta($id, 'mfn-page-items', true);
    h_out([
      'id' => $id, 'title' => $post->post_title, 'url' => get_permalink($id), 'status' => $post->post_status,
      'modified' => $post->post_modified, 'currentContentChars' => mb_strlen((string) $post->post_content),
      'revisionsEnabled' => (bool) wp_revisions_enabled($post), 'revisionsKept' => wp_revisions_to_keep($post),
      'builderPost' => !empty($builder), 'count' => count($out), 'revisions' => $out,
      'note' => !empty($builder) ? 'This post keeps its text in builder meta, which WordPress does not version: revisions only cover post_content. Use wp_builder_check / wp_builder_restore instead.' : null,
    ]);
  }

  case 'revision_restore': {
    $id = (int) ($in['id'] ?? 0);
    $rid = (int) ($in['revisionId'] ?? 0);
    $post = get_post($id);
    if (!$post) h_fail("post {$id} not found");
    $rev = wp_get_post_revision($rid);
    if (!$rev) h_fail("revision {$rid} not found");
    if ((int) $rev->post_parent !== $id) h_fail("revision {$rid} belongs to post {$rev->post_parent}, not {$id}");
    $builder = get_post_meta($id, 'mfn-page-items', true);
    $diff = [
      'title' => ['from' => $post->post_title, 'to' => $rev->post_title],
      'excerpt' => ['from' => mb_substr((string) $post->post_excerpt, 0, 300), 'to' => mb_substr((string) $rev->post_excerpt, 0, 300)],
      'content' => h_diff_lines($post->post_content, $rev->post_content),
    ];
    if (!empty($in['dryRun'])) {
      h_out(['dryRun' => true, 'id' => $id, 'revisionId' => $rid, 'revisionDate' => $rev->post_date, 'diff' => $diff, 'builderPost' => !empty($builder), 'note' => 'Nothing was written. Call again with dryRun=false to restore; the current state is kept as a new revision.']);
    }
    $res = wp_restore_post_revision($rid);
    if (!$res) h_fail('WordPress refused the restore (revisions may be disabled for this post type, or the revision is identical)');
    $after = get_post($id);
    h_out([
      'restored' => true, 'id' => $id, 'revisionId' => $rid, 'revisionDate' => $rev->post_date,
      'title' => $after->post_title, 'contentChars' => mb_strlen((string) $after->post_content), 'url' => get_permalink($id),
      'diff' => $diff, 'builderPost' => !empty($builder), 'indexable' => h_yoast_rebuild($id), 'purged' => h_purge($id),
      'note' => !empty($builder) ? 'This is a builder post: its visible text lives in meta and was NOT restored. Use wp_builder_restore for that.' : null,
    ]);
  }

  case 'purge_site': {
    $done = [];
    if (!empty($in['pageCache'])) $done['pageCache'] = h_purge_site();
    if (!empty($in['objectCache'])) { wp_cache_flush(); $done['objectCache'] = 'flushed'; }
    if (!empty($in['yoastSitemap'])) $done['yoastSitemap'] = h_flush_yoast_sitemap();
    if (!empty($in['usedCss'])) $done['usedCss'] = h_clear_used_css();
    h_out(['purged' => $done]);
  }

  default:
    h_fail("unknown action '{$action}'");
}
