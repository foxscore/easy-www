const Handlebars = require("handlebars");
const core = require('@actions/core');
const { exit, env } = require("process");
const i18next = require("i18next");
const parse5 = require("parse5");
const chalk = require("chalk");
const glob = require("glob");
const path = require("path");
const fs = require("fs");
const showdown = require("showdown");
const converter = new showdown.Converter();

const file_releases = 'tmp/releases.json';
const file_contributors = 'tmp/contributors.json';

let currentResource;

class Release {
  name = '';
  displayName = '';
  downloads = [];
  isGui = false;
}

// Configuration
const config = {
  localesDir: "./locales",
  templatesDir: "./src",
  componentsDir: "./components",
  outputDir: "./dist",
  excludePatterns: ["**/*.html", "**/*.hbs"],
  defaultLanguage: "en",
  safeTags: ["b", "i", "br", "code"],
  safeAttributes: [],
};

// Logger function
const log = (message, type = "info") => {
  if (process.env.GITHUB_ACTIONS !== undefined) {
    switch (type) {
      case 'error':
        core.error(message);
        break;
      case 'warning':
        core.warning(message);
        break;
      case 'debug':
        core.debug(message);
        break;
      case 'info':
      default:
        core.info(message);
        break;
    }
  } else {
    const prefix =
      {
        info: chalk.blue("INFO"),
        warning: chalk.yellow("WARN"),
        error: chalk.red("ERROR"),
      }[type] || chalk.gray("LOG");

    console.log(`[${prefix}] ${message}`);
  }
};

function trimEndNewline(str) {
  if (str.endsWith('\n')) {
    return str.slice(0, -1);
  }
  return str;
}

function copyMissing(from, to, toName, keySoFar = '') {
  for (const key in from) {
    if (!(key in to)) {
      log(`Key ${keySoFar}${key} is missing from ${toName}`, 'warning')
      to[key] = from[key];
      continue;
    }

    if (typeof from[key] === 'object') {
      to[key] = copyMissing(from[key], to[key], toName, `${keySoFar}${key}.`);
    }
  }
  return to;
}

// Build function
async function build() {
  try {
    log("Starting build...");

    // Load locales (using async/await for i18next.init)
    const locales = fs
      .readdirSync(config.localesDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(".json", ""))
      .sort();

    const resources = {};
    let defaultLocale = require("./" + path.join(config.localesDir, `${config.defaultLanguage}.json`));
    locales.forEach((locale) => {
      const localePath = "./" + path.join(config.localesDir, `${locale}.json`);
      let json = require(localePath);

      if (locale !== config.defaultLanguage) {
        json = copyMissing(defaultLocale, json, localePath);
      }

      resources[locale] = {
        translation: json,
      };
    });
    log(locales);
    await i18next.init({
      lng: config.defaultLanguage,
      resources,
    });

    // Register the not helper
    Handlebars.registerHelper('not', function (value) {
      return !value;
    });

    // Register the safe-html helper
    Handlebars.registerHelper("safe", function (key) {
      const translatedString = i18next.t(key);

      // Recursive sanitization function
      function sanitize(node) {
        if (node.type === "tag") {
          if (!config.safeTags.includes(node.name.toLowerCase())) {
            return "";
          }

          // Sanitize attributes
          node.attribs = Object.keys(node.attribs).reduce((acc, attr) => {
            if (config.safeAttributes.includes(attr.toLowerCase())) {
              acc[attr] = node.attribs[attr];
            }
            return acc;
          }, {});
        }
        if (node.children) {
          node.children = node.children.map(sanitize).filter(Boolean);
        }
        return node;
      }

      // Parse, sanitize, and serialize
      const doc = parse5.parseFragment(translatedString);
      const sanitized = parse5.serialize(sanitize(doc));

      return new Handlebars.SafeString(sanitized);
    });

    Handlebars.registerHelper("renderMarkdown", function(key) {
      let markdown = i18next.t(key);
      if (markdown === undefined || markdown === '') {
        markdown = `*${currentResource.releases.noChangelogMessage}*`;
      } else {
        markdown = trimEndNewline(markdown);
      }
      const html = converter.makeHtml(markdown);
      return new Handlebars.SafeString(html);
    })

    // Register the contains helper
    Handlebars.registerHelper("contains", function (arrayStr, value, options) {
      const array = (arrayStr ?? "").split(",").map((s) => s.trim());
      if (array && array.indexOf(value) !== -1) {
        return true;
      } else {
        return false;
      }
    });

    // Register components
    const componentFiles = fs
      .readdirSync(config.componentsDir)
      .filter((file) => file.endsWith(".hbs"))
      .map((file) => file.replace(".hbs", ""));
    componentFiles.forEach((componentFile) => {
      const raw = fs.readFileSync(
        path.join(config.componentsDir, componentFile + ".hbs"),
        "utf-8",
      );
      Handlebars.registerPartial(componentFile, raw);
    });

    // Remove previous instance of the output directory
    if (fs.existsSync(config.outputDir))
      fs.rmSync(config.outputDir, { recursive: true, force: true });

    // Find & copy non-HTML files (excluding patterns)
    const nonHtmlFiles = glob
      .sync(`${config.templatesDir}/**/*`, { nodir: true })
      .filter(
        (file) =>
          !config.excludePatterns.some((pattern) => {
            const regex = new RegExp(pattern.replace(/\*\*/g, ".*"));
            return regex.test(file);
          }),
      );

    nonHtmlFiles.forEach((file) => {
      const relativePath = path.relative(config.templatesDir, file);
      const outputPath = path.join(config.outputDir, relativePath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.copyFileSync(file, outputPath);
      log(`Copied: ${relativePath}`);
    });

    // Update the locales
    let localesList = {};
    for (const locale of locales) {
      const resources = i18next.getResourceBundle(locale, "translation");
      localesList[resources.locale.code] = resources.locale;
    }
    const outputPath = path.join(config.outputDir, "resources", "locales");
    fs.mkdirSync(outputPath, { recursive: true });
    for (const locale of locales) {
      const resources = i18next.getResourceBundle(locale, "translation");
      resources.data = {
        locales: localesList
      };
      const raw = JSON.stringify(resources, null, "\t");
      fs.writeFileSync(path.join(outputPath, locale + ".json"), raw);
    }

    // Find HTML templates & generate localized pages
    const templateFiles = glob
      .sync(`${config.templatesDir}/**/*.{html,hbs}`)
      .filter((filePath) => !path.basename(filePath).startsWith("_"));

    for (const templateFile of templateFiles) {
      const template = Handlebars.compile(
        fs.readFileSync(templateFile, "utf8"),
      );

      for (const locale of locales) {
        const resources = i18next.getResourceBundle(locale, "translation");
        currentResource = resources;
        const relativePath = path.relative(config.templatesDir, templateFile);
        let url = path.dirname(relativePath);
        if (url === '.') url = '';
        else url = url + '/';
        resources.data.relativeURL = url;
        const htmlContent = template(resources);

        let outputPath = path.join(config.outputDir, locale, relativePath);
        if (outputPath.endsWith(".hbs")) {
          outputPath = outputPath.replace(/\.hbs$/, ".html");
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, htmlContent);
        if (locale === config.defaultLanguage) {
          outputPath = path.join(config.outputDir, relativePath);
          if (outputPath.endsWith(".hbs")) {
            outputPath = outputPath.replace(/\.hbs$/, ".html");
          }
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, htmlContent);
        }
        log(`Built: ${outputPath} (locale: ${locale})`);
      }
    }

    log("Build complete!");
  } catch (error) {
    log(`Build failed: ${error.message}`, "error");
    log(error.stack, "error");
    exit(1);
  }
}

build();
