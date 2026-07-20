export interface EditorPreferences {
  enabled: boolean;
  autosave: boolean;
  highlights: boolean;
}

export const PREFERENCES_EVENT = 'astro-wysiwyg:preferences';
export const FRONTMATTER_EVENT = 'astro-wysiwyg:open-frontmatter';
export const CREATE_COLLECTION_ENTRY_EVENT = 'astro-wysiwyg:create-collection-entry';
export const PREFERENCES_KEY = 'astro-wysiwyg-preferences';
export const DEFAULT_PREFERENCES: EditorPreferences = {
  enabled: true,
  autosave: true,
  highlights: true,
};

export function readPreferences(): EditorPreferences {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    if (!stored) return { ...DEFAULT_PREFERENCES };
    const value = JSON.parse(stored) as Partial<EditorPreferences>;
    return {
      enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
      autosave: typeof value.autosave === 'boolean' ? value.autosave : true,
      highlights: typeof value.highlights === 'boolean' ? value.highlights : true,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function updatePreferences(patch: Partial<EditorPreferences>): EditorPreferences {
  const preferences = { ...readPreferences(), ...patch };
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // The current page still receives the preference event when storage is unavailable.
  }
  document.dispatchEvent(new CustomEvent(PREFERENCES_EVENT, { detail: preferences }));
  return preferences;
}
