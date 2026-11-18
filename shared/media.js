// Files a browser shows itself, by extension: what opens in a viewer tab rather than the editor. Shared by the
// server, which serves only these, and the page, which picks the viewer.

export const MEDIA_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
};

/** The content type for a file name, by its extension, or null (also for a name without one). */
export function mediaType(p) {
  const name = String(p).split('/').pop();
  const i = name.lastIndexOf('.');
  return i > 0 ? MEDIA_TYPES[name.slice(i + 1).toLowerCase()] || null : null;
}

/** pdf, image, video or audio for a file name, or null. */
export function mediaKind(p) {
  const type = mediaType(p);
  if (!type) return null;
  return type === 'application/pdf' ? 'pdf' : type.split('/')[0];
}
