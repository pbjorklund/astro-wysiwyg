---
layout: ../layouts/Layout.astro
title: Images
description: Upload, insert, preview, and replace source-backed images while keeping useful alt text.
---
# Image insertion

This page covers Markdown targets. Use the [Astro image targets](/image-astro) and [MDX image target](/image-mdx) for the other supported source forms.

Select this paragraph, then use **Insert > Image** to upload a raster image and place it below the paragraph.

A successful insertion stays source-backed, so you can select the image block and remove it with the same **Delete** action as other blocks.

## Image replacement

Select the linked image below, then use **Replace image**. You can upload a new file or choose `/assets/replace-alternate.png`, preview it, update the alt text, and replace the source reference without losing the link, title, or caption.

[![Original replaceable example](/assets/replace-original.png "Replaceable demo image")](/images) This linked caption stays in place.

The next image uses a path relative to this Markdown source file. Replace it with `../assets/replace-source-alternate.png` to exercise source asset validation and preview.

![Original source asset example](../assets/replace-source-original.png)
