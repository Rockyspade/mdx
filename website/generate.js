#!/usr/bin/env node
/**
 * @typedef {import('hast').Element} Element
 * @typedef {import('hast').Properties} Properties
 * @typedef {import('hast').Root} Root
 * @typedef {import('mdx/types.js').MDXContent} MDXContent
 * @typedef {Exclude<import('vfile').Data['meta'], undefined>} Meta
 * @typedef {Exclude<import('vfile').Data['matter'], undefined>} Matter
 * @typedef {import('../docs/_component/sort.js').Item} Item
 */

/**
 * @typedef Author
 * @property {string | undefined} [github]
 * @property {string} name
 * @property {string | undefined} [twitter]
 * @property {string | undefined} [url]
 *
 * @typedef Info
 * @property {Array<Author> | Author | undefined} [author]
 * @property {string | undefined} [authorTwitter]
 * @property {Date | undefined} [published]
 * @property {Date | undefined} [modified]
 */

import assert from 'assert'
import {promises as fs} from 'fs'
import path from 'path'
import process from 'process'
import {fileURLToPath} from 'url'
import React from 'react'
import {renderToString} from 'react-dom/server'
import pAll from 'p-all'
import {globby} from 'globby'
import {sitemap} from 'xast-util-sitemap'
import {unified} from 'unified'
import {h} from 'hastscript'
import {select} from 'hast-util-select'
import {VFile} from 'vfile'
import rehypeParse from 'rehype-parse'
import rehypeDocument from 'rehype-document'
import rehypeMeta from 'rehype-meta'
import rehypePresetMinify from 'rehype-preset-minify'
import rehypeMinifyUrl from 'rehype-minify-url'
import rehypeStringify from 'rehype-stringify'
import rehypeSanitize from 'rehype-sanitize'
import {toXml} from 'xast-util-to-xml'
import {Layout} from '../docs/_component/layout.jsx'
import {config} from '../docs/_config.js'
import {schema} from './schema-description.js'

const listFormat = new Intl.ListFormat('en')

process.on('exit', () => {
  console.log('✔ Generate')
})

const files = (
  await globby(['**/*.{md,mdx}', '!_component/*'], {
    cwd: fileURLToPath(config.input)
  })
).map((d) => new URL(d, config.input))

const allInfo = await pAll(
  files.map((url) => async () => {
    const name = url.href
      .slice(config.input.href.length - 1)
      .replace(/\.mdx?$/, '/')
      .replace(/\/index\/$/, '/')
    const jsonUrl = new URL('.' + name + 'index.json', config.output)
    const ghUrl = new URL(url.href.slice(config.git.href.length), config.ghBlob)

    /** @type {{default: MDXContent, info?: Info, matter: Matter, meta: Meta, navSortSelf?: number | undefined, navExclude?: boolean | undefined}} */
    const mod = await import(url.href)
    const {default: Content, info, ...data} = mod
    // Handle `author` differently.
    const {author, ...restInfo} = info || {}
    const authors = Array.isArray(author) ? author : author ? [author] : []
    const authorNames = authors.map((d) => d.name)

    if (authors[0] && authors[0].twitter) {
      restInfo.authorTwitter = authors[0].twitter
    }

    const abbreviatedAuthors =
      authorNames.length > 3
        ? [...authorNames.slice(0, 2), 'others']
        : authorNames

    data.meta = {
      ...restInfo,
      // @ts-expect-error: to do: type authors.
      authors,
      author:
        abbreviatedAuthors.length > 0
          ? listFormat.format(abbreviatedAuthors)
          : undefined,
      ...data.meta
    }

    // Sanitize the hast description:
    if (data.meta && data.meta.descriptionHast) {
      data.meta.descriptionHast = unified()
        .use(rehypeSanitize, schema)
        // @ts-expect-error: element is fine.
        .runSync(data.meta.descriptionHast)
    }

    return {name, url, ghUrl, jsonUrl, data, Content}
  }),
  {concurrency: 6}
)

/** @type {Item} */
const navTree = {name: '/', data: {}, children: []}
let index = -1

while (++index < allInfo.length) {
  const {name, data} = allInfo[index]
  const parts = name.split('/').slice(0, -1)
  let partIndex = 0
  let context = navTree

  if (data.navExclude) continue

  while (++partIndex < parts.length) {
    const name = parts.slice(0, partIndex + 1).join('/') + '/'
    let contextItem = context.children.find((d) => d.name === name)

    if (!contextItem) {
      contextItem = {name, data: {}, children: []}
      context.children.push(contextItem)
    }

    context = contextItem
  }

  context.data = data
}

await fs.writeFile(
  new URL('sitemap.xml', config.output),
  toXml(
    sitemap(
      allInfo.map((d) => ({
        url: new URL(d.name, config.site).href,
        modified: d.data && d.data.meta && d.data.meta.modified,
        lang: 'en'
      }))
    )
  )
)

console.log('✔ `/sitemap.xml`')

index = -1

await pAll(
  allInfo.map((d) => async () => {
    const {name, data, Content, ghUrl, jsonUrl} = d

    await fs.mkdir(path.dirname(fileURLToPath(jsonUrl)), {recursive: true})
    await fs.writeFile(jsonUrl, JSON.stringify(data))

    const element = React.createElement(Content, {
      components: {wrapper: Layout},
      ...data,
      name,
      ghUrl,
      navTree
    })

    const result = renderToString(element)

    const canonical = new URL(name, config.site)
    data.meta.origin = canonical.origin
    data.meta.pathname = canonical.pathname

    const file = await unified()
      .use(rehypeParse, {fragment: true})
      .use(rehypeDocument, {
        language: 'en',
        css: ['/index.css'],
        link: [
          {
            rel: 'alternate',
            href: new URL('rss.xml', config.site).href,
            type: 'application/rss+xml',
            title: config.site.hostname
          },
          {
            rel: 'icon',
            href: new URL('favicon.ico', config.site).href,
            sizes: 'any'
          },
          {
            rel: 'icon',
            href: new URL('icon.svg', config.site).href,
            type: 'image/svg+xml'
          }
        ],
        // To do: only include editor on playground?
        // Or use more editors.
        js: ['/index.js', '/editor.js'],
        meta: [{name: 'generator', content: 'mdx'}]
      })
      .use(rehypeMeta, {
        twitter: true,
        og: true,
        ogNameInTitle: true,
        copyright: true,
        type: 'article',
        name: config.title,
        siteTags: config.tags,
        siteAuthor: config.author,
        siteTwitter: '@' + config.twitter.pathname.slice(1),
        separator: ' | ',
        color: config.color,
        image:
          name === '/'
            ? {
                url: new URL('og.png', config.site).href,
                width: 3062,
                height: 1490
              }
            : {
                url:
                  name === '/blog/v2/' || name === '/migrating/v2/'
                    ? new URL('og-v2.png', config.site).href
                    : new URL('index.png', canonical).href,
                width: 2400,
                height: 1256
              }
      })
      .use(rehypeLazyCss, [
        {href: 'https://esm.sh/@wooorm/starry-night@3/style/both.css'}
      ])
      .use(rehypePresetMinify)
      .use(rehypeMinifyUrl, {from: canonical.href})
      .use(rehypeStringify, {bogusComments: false})
      .process(
        new VFile({
          path: new URL('index.html', jsonUrl),
          value: result,
          data
        })
      )

    if (file.dirname) await fs.mkdir(file.dirname, {recursive: true})
    await fs.writeFile(file.path, String(file))
    console.log('  generate: `%s`', name)
  }),
  {concurrency: 6}
)

/**
 * @param {ReadonlyArray<Properties>} styles
 *   Styles.
 * @returns
 *   Transform.
 */
function rehypeLazyCss(styles) {
  /**
   * @param {Root} tree
   *   Styles.
   * @returns {undefined}
   *   Nothing.
   */
  return (tree) => {
    const head = select('head', tree)
    assert(head)
    /** @type {Array<Element>} */
    const enabled = []
    /** @type {Array<Element>} */
    const disabled = []

    let index = -1
    while (++index < styles.length) {
      // To do: structured clone.
      const props = styles[index]
      enabled.push(
        h('link', {
          ...props,
          rel: 'preload',
          as: 'style',
          onLoad: "this.onload=null;this.rel='stylesheet'"
        })
      )
      disabled.push(h('link', {...props, rel: 'stylesheet'}))
    }

    head.children.push(...enabled)

    if (disabled.length > 0) {
      head.children.push(h('noscript', disabled))
    }
  }
}