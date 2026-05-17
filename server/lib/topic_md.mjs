// Server-side parser for topic.md. Extracts the contact email and other
// fields needed by the search and download stages.

export function parseTopic(md) {
  const out = {
    title: '',
    description: '',
    contact_email: '',
    year_min: 2018,
    year_max: 'present',
    categories: [],
    method_families: [],
    entity_types: [],
  };
  if (!md) return out;

  const titleMatch = md.match(/title:\s*(.+)/);
  if (titleMatch) out.title = titleMatch[1].trim();

  const emailMatch = md.match(/contact_email:\s*(\S+)/);
  if (emailMatch && !emailMatch[1].toUpperCase().startsWith('REPLACE')) {
    out.contact_email = emailMatch[1];
  }

  const yMin = md.match(/year_min:\s*(\d+)/);
  if (yMin) out.year_min = parseInt(yMin[1], 10);
  const yMax = md.match(/year_max:\s*(\S+)/);
  if (yMax) out.year_max = yMax[1].trim();

  const desc = md.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/);
  if (desc) {
    out.description = desc[1].split('\n').map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim();
  }

  const cat = md.match(/categories:\s*\n((?:[ \t]*-[ \t]*\S.*\n?)+)/);
  if (cat) {
    out.categories = (cat[1].match(/-\s*([^\n]+)/g) || [])
      .map((s) => s.replace(/^-\s*/, '').trim())
      .filter((s) => s && !/^replace_with/.test(s));
  }

  const meth = md.match(/method_families:\s*\n((?:[ \t]*-[ \t]*\S.*\n?)+)/);
  if (meth) {
    out.method_families = (meth[1].match(/-\s*([^\n]+)/g) || [])
      .map((s) => s.replace(/^-\s*/, '').trim());
  }

  const ent = md.match(/entity_types:\s*\n((?:[ \t]*-[ \t]*\S.*\n?)+)/);
  if (ent) {
    out.entity_types = (ent[1].match(/-\s*([^\n]+)/g) || [])
      .map((s) => s.replace(/^-\s*/, '').trim())
      .filter((s) => s && !/^replace_with/.test(s));
  }

  // Optional: which entity_types feed the theoretical-gap detector. When
  // unset the detector picks framework-like kinds heuristically.
  const tkinds = md.match(/theoretical_kinds:\s*\n((?:[ \t]*-[ \t]*\S.*\n?)+)/);
  if (tkinds) {
    out.theoretical_kinds = (tkinds[1].match(/-\s*([^\n]+)/g) || [])
      .map((s) => s.replace(/^-\s*/, '').trim())
      .filter(Boolean);
  }

  const target = md.match(/target_includes:\s*(\d+)/);
  if (target) out.target_includes = parseInt(target[1], 10);
  const minimum = md.match(/minimum_includes:\s*(\d+)/);
  if (minimum) out.minimum_includes = parseInt(minimum[1], 10);

  return out;
}
