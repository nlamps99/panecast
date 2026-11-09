module.exports = ({ config }) => ({
  ...config,
  web: { ...config.web, output: process.env.PANECAST_DESKTOP_BUILD === '1' ? 'single' : config.web.output },
});
