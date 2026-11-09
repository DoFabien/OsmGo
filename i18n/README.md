# Interface translations

The interface texts are translated with an AI model from the English catalog.

- `src/assets/i18n/en.json`: the source texts. Every new key is added here first.
- `i18n/en.context.json`: the same keys, each with a note for the translator:
  the kind of element (button, title, message, screen reader label…), where it
  appears, what `{{placeholders}}` contain, length limits and OpenStreetMap
  terms. It is not shipped with the application.
- `src/assets/i18n/<lang>.json`: the translations. A missing key falls back to
  English.
- `src/assets/i18n/i18n.json`: `uiLanguages` lists the languages offered in the
  settings.

## Adding or changing a text

1. Add or change the English text in `en.json`.
2. Add or update its note in `en.context.json`. Say what the English text does
   not: where it is shown, what the action does, what each placeholder is.
3. Update `fr.json` (French is maintained with the code).
4. Run `npm run i18n -- check`. The unit tests run the same checks.

When the meaning of an English text changes, its existing translations are
outdated: translate them again with `todo <lang> --all`, or remove the key from
the other catalogs so that they fall back to English until they are translated.

## Translating

```bash
npm run i18n -- todo de
```

This writes `i18n/todo/de.json` (ignored by git) with, for each missing text,
the English source, its context, the French translation as a second reference
and an empty `translation` field. `--all` includes the texts that are already
translated, with the current translation, to review a whole language.

Give the file to the AI model with the instructions below, then merge its
answer:

```bash
npm run i18n -- apply de
npm run i18n -- check
```

`apply` keeps the existing translations, writes the new ones in the order of
`en.json` and refuses a text whose placeholders differ from the English ones.

## Instructions for the translator

You translate the interface of Osm Go!, a mobile application used outdoors to
add and edit points of interest in OpenStreetMap. Fill the `translation` field
of every entry in the target language of the file. Change nothing else.

- Translate the meaning for the use described in `context`, not word for word.
  `fr` is a reviewed French translation, useful when the English is ambiguous.
- Keep every `{{placeholder}}` exactly as written, with the same name. Move it
  where the grammar of the language needs it.
- Use the terms of the OpenStreetMap community in that language (see the
  OpenStreetMap wiki): changeset, tag, key, value, node, way, relation,
  preset. Never translate OpenStreetMap, Osm Go!, tag keys such as
  `check_date` or `opening_hours`, or URLs.
- Buttons and menu items are short, with the usual imperative or infinitive
  form of the platform in that language. Respect the length limits given in
  the context.
- Use the tone of mobile applications in that language: direct and polite,
  the usual form of address (for example "vous" in French, "Sie" in German).
- Keep typographic conventions of the language (quotes, spaces before
  punctuation, capitalization of titles).
- When `current` holds a translation, keep it unless it is wrong, unclear or
  inconsistent with the other texts.
