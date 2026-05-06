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

  return out;
}
