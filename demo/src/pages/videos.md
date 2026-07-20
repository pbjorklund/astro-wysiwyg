---
layout: ../layouts/Layout.astro
title: Videos
description: Upload an H.264 MP4 and insert portable native video markup with accessible playback settings.
---
# Native video insertion

Select this paragraph, then use **Insert > Video** to upload an H.264 MP4 and place a native player below it.

The editor requires native controls, an accessible label, and a visible description. Autoplay is available only with muted playback. Spoken prerecorded content still needs captions added in source.

Use the replaceable native players on the [Astro](/video-astro) and [MDX](/video-mdx) routes to review source, poster, accessibility, and playback preservation.

<figure>
  <video controls preload="metadata" aria-label="Astro WYSIWYG native video example" poster="/assets/astro-wysiwyg-video-poster.png" playsinline>
    <source src="/assets/astro-wysiwyg-demo.mp4" type="video/mp4" />
    <track kind="captions" src="/assets/astro-wysiwyg-demo.vtt" srclang="en" label="English" default />
    <a href="/assets/astro-wysiwyg-demo.mp4" download>Download Astro WYSIWYG native video example</a>.
  </video>
  <figcaption>A short silent example rendered by Astro as native HTML video.</figcaption>
</figure>
