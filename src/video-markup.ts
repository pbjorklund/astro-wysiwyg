export interface VideoReplacementFields {
  src: string;
  label: string;
  description: string;
  poster?: string;
  controls: boolean;
  preload: 'auto' | 'metadata' | 'none';
  muted: boolean;
  loop: boolean;
  autoplay: boolean;
}

interface ParsedAttribute {
  name: string;
  start: number;
  end: number;
  value?: string;
}

interface ParsedTag {
  start: number;
  end: number;
  attributes: ParsedAttribute[];
}

export interface SourceVideoFigure {
  src: string;
  label: string;
  description: string;
  poster?: string;
  controls: true;
  preload: 'auto' | 'metadata' | 'none';
  muted: boolean;
  loop: boolean;
  autoplay: boolean;
}

export function inspectSourceVideoFigure(source: string): SourceVideoFigure | undefined {
  const figure = rootElement(source, 'figure');
  if (!figure || !attributeMap(figure.open)) return undefined;
  const videos = findOpeningTags(source, 'video', figure.open.end, figure.closeStart);
  const captions = findElements(source, 'figcaption', figure.open.end, figure.closeStart);
  if (videos.length !== 1 || captions.length !== 1) return undefined;
  const video = videos[0];
  const videoClose = source.toLowerCase().indexOf('</video>', video.end);
  if (videoClose < video.end || videoClose > figure.closeStart) return undefined;
  const sources = findOpeningTags(source, 'source', video.end, videoClose);
  if (sources.length !== 1) return undefined;
  const sourceTag = sources[0];
  const sourceAttributes = attributeMap(sourceTag);
  const videoAttributes = attributeMap(video);
  if (!sourceAttributes || !videoAttributes) return undefined;
  const src = sourceAttributes.get('src')?.value;
  const type = sourceAttributes.get('type')?.value?.toLowerCase();
  const label = videoAttributes.get('aria-label')?.value;
  const preload = videoAttributes.get('preload')?.value;
  const poster = videoAttributes.get('poster')?.value;
  const captionText = source.slice(captions[0].contentStart, captions[0].contentEnd);
  if (!src || !isPublicMp4Reference(src) || type !== 'video/mp4' || !label
    || !['auto', 'metadata', 'none'].includes(preload ?? '')
    || !videoAttributes.has('controls') || /[<>{}]/.test(captionText) || !captionText.trim()) return undefined;
  if (poster && !isPublicPosterReference(poster)) return undefined;
  const autoplay = videoAttributes.has('autoplay');
  const muted = videoAttributes.has('muted');
  if (autoplay && !muted) return undefined;
  return {
    src,
    label,
    description: captionText,
    poster,
    controls: true,
    preload: preload as SourceVideoFigure['preload'],
    muted,
    loop: videoAttributes.has('loop'),
    autoplay,
  };
}

export function replaceSourceVideoFigure(source: string, fields: VideoReplacementFields): string | undefined {
  const current = inspectSourceVideoFigure(source);
  const figure = rootElement(source, 'figure');
  if (!current || !figure) return undefined;
  const video = findOpeningTags(source, 'video', figure.open.end, figure.closeStart)[0];
  const videoClose = source.toLowerCase().indexOf('</video>', video.end);
  const sourceTag = findOpeningTags(source, 'source', video.end, videoClose)[0];
  const caption = findElements(source, 'figcaption', figure.open.end, figure.closeStart)[0];
  const edits: Array<{ start: number; end: number; value: string }> = [
    {
      start: video.start,
      end: video.end,
      value: updateTag(source.slice(video.start, video.end), {
        controls: fields.controls,
        preload: fields.preload,
        'aria-label': fields.label,
        poster: fields.poster,
        muted: fields.muted,
        loop: fields.loop,
        autoplay: fields.autoplay,
      }),
    },
    {
      start: sourceTag.start,
      end: sourceTag.end,
      value: updateTag(source.slice(sourceTag.start, sourceTag.end), { src: fields.src }),
    },
    {
      start: caption.contentStart,
      end: caption.contentEnd,
      value: escapeHtmlText(fields.description),
    },
  ];
  for (const anchor of findOpeningTags(source, 'a', video.end, videoClose)) {
    const attributes = attributeMap(anchor);
    if (attributes?.get('href')?.value === current.src) {
      edits.push({
        start: anchor.start,
        end: anchor.end,
        value: updateTag(source.slice(anchor.start, anchor.end), { href: fields.src }),
      });
    }
  }
  let updated = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, edit.start) + edit.value + updated.slice(edit.end);
  }
  return inspectSourceVideoFigure(updated) ? updated : undefined;
}

export function addVideoMarkerAttributes(source: string, marker: string): string | undefined {
  const figure = rootElement(source, 'figure');
  if (!figure || !inspectSourceVideoFigure(source)) return undefined;
  const opening = source.slice(figure.open.start, figure.open.end);
  const marked = updateTag(opening, {
    'data-astro-wysiwyg': marker,
    'data-astro-wysiwyg-video': true,
  });
  return source.slice(0, figure.open.start) + marked + source.slice(figure.open.end);
}

function rootElement(source: string, name: string): { open: ParsedTag; closeStart: number } | undefined {
  const leading = /^\s*/.exec(source)![0].length;
  const open = parseTag(source, leading, name);
  if (!open) return undefined;
  const closing = new RegExp(`</${name}\\s*>\\s*$`, 'i').exec(source);
  if (!closing || closing.index < open.end) return undefined;
  return { open, closeStart: closing.index };
}

function findElements(
  source: string,
  name: string,
  start: number,
  end: number,
): Array<{ open: ParsedTag; contentStart: number; contentEnd: number }> {
  const openings = findOpeningTags(source, name, start, end);
  const closingPattern = new RegExp(`</${name}\\s*>`, 'ig');
  return openings.flatMap((open) => {
    closingPattern.lastIndex = open.end;
    const close = closingPattern.exec(source);
    return close && close.index <= end
      ? [{ open, contentStart: open.end, contentEnd: close.index }]
      : [];
  });
}

function findOpeningTags(source: string, name: string, start: number, end: number): ParsedTag[] {
  const matches: ParsedTag[] = [];
  const pattern = new RegExp(`<${name}\\b`, 'ig');
  pattern.lastIndex = start;
  for (let match = pattern.exec(source); match && match.index < end; match = pattern.exec(source)) {
    const tag = parseTag(source, match.index, name);
    if (!tag || tag.end > end) return [];
    matches.push(tag);
    pattern.lastIndex = tag.end;
  }
  return matches;
}

function parseTag(source: string, start: number, expectedName: string): ParsedTag | undefined {
  const prefix = new RegExp(`^<${expectedName}\\b`, 'i').exec(source.slice(start));
  if (!prefix) return undefined;
  let index = start + prefix[0].length;
  const attributes: ParsedAttribute[] = [];
  while (index < source.length) {
    const whitespaceStart = index;
    while (/\s/.test(source[index] ?? '')) index += 1;
    if (source[index] === '>' || source.slice(index, index + 2) === '/>') {
      return { start, end: index + (source[index] === '>' ? 1 : 2), attributes };
    }
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9:._-]*/.exec(source.slice(index));
    if (!nameMatch) return undefined;
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    const nameEnd = index;
    while (/\s/.test(source[index] ?? '')) index += 1;
    let value: string | undefined;
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] ?? '')) index += 1;
      const quote = source[index];
      if (quote !== '"' && quote !== "'") return undefined;
      const valueStart = ++index;
      while (index < source.length && source[index] !== quote) index += 1;
      if (source[index] !== quote) return undefined;
      value = source.slice(valueStart, index);
      index += 1;
    } else {
      index = nameEnd;
    }
    attributes.push({ name, start: whitespaceStart - start, end: index - start, value });
  }
  return undefined;
}

function attributeMap(tag: ParsedTag): Map<string, ParsedAttribute> | undefined {
  const map = new Map<string, ParsedAttribute>();
  for (const attribute of tag.attributes) {
    if (map.has(attribute.name)) return undefined;
    map.set(attribute.name, attribute);
  }
  return map;
}

function updateTag(
  tag: string,
  changes: Record<string, string | boolean | undefined>,
): string {
  const name = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(tag)?.[1];
  /* c8 ignore next -- Callers pass opening tags already parsed from a supported figure. */
  if (!name) return tag;
  const parsed = parseTag(tag, 0, name);
  /* c8 ignore next -- Callers pass opening tags already parsed from a supported figure. */
  if (!parsed) return tag;
  const attributes = attributeMap(parsed);
  /* c8 ignore next -- Supported source, video, and fallback tags have unambiguous attributes. */
  if (!attributes) return tag;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const additions: string[] = [];
  for (const [nameValue, desired] of Object.entries(changes)) {
    const name = nameValue.toLowerCase();
    const current = attributes.get(name);
    if (desired === undefined || desired === false) {
      if (current) edits.push({ start: current.start, end: current.end, value: '' });
    } else {
      const serialized = desired === true ? name : `${name}="${escapeHtmlAttribute(desired)}"`;
      if (current) edits.push({ start: current.start, end: current.end, value: ` ${serialized}` });
      else additions.push(serialized);
    }
  }
  if (additions.length) {
    /* c8 ignore next -- Supported marker and video-field additions target non-void figure or video tags. */
    const closingStart = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;
    edits.push({ start: closingStart, end: closingStart, value: ` ${additions.join(' ')}` });
  }
  let updated = tag;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, edit.start) + edit.value + updated.slice(edit.end);
  }
  return updated;
}

function isPublicMp4Reference(value: string): boolean {
  return /^\/[A-Za-z0-9._/-]+\.mp4$/i.test(value)
    && !value.split('/').includes('..')
    && !/[?#\\]/.test(value);
}

function isPublicPosterReference(value: string): boolean {
  return /^\/[A-Za-z0-9._/-]+\.(?:gif|jpe?g|png|webp)$/i.test(value)
    && !value.split('/').includes('..')
    && !/[?#\\]/.test(value);
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
