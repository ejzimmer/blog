const syntaxHighlight = require("@11ty/eleventy-plugin-syntaxhighlight");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("./css");
  eleventyConfig.addPlugin(syntaxHighlight, {
    alwaysWrapLineHighlights: true
  });

  return {
    dir: {
      input: ".",
      output: "public",
    },
  };
};
