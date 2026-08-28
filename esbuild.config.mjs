import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const prod = process.argv[2] === 'production';

function buildStyles() {
  const tokens = fs.readFileSync(path.resolve('../sbe-core/src/design/tokens.css'), 'utf8');
  const components = fs.readFileSync(path.resolve('../sbe-core/src/design/components.css'), 'utf8');
  const own = fs.existsSync(path.resolve('src/styles.css'))
    ? fs.readFileSync(path.resolve('src/styles.css'), 'utf8')
    : '';
  fs.writeFileSync(path.resolve('styles.css'), `${tokens}\n${components}\n${own}`);
}

const stylesPlugin = {
  name: 'sbe-styles',
  setup(build) {
    build.onEnd(() => {
      try {
        buildStyles();
      } catch (e) {
        console.error('SBE Photobank: не удалось собрать styles.css:', e);
      }
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  platform: 'browser',
  format: 'cjs',
  target: 'es2021',
  external: ['obsidian', 'electron'],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  logLevel: 'info',
  plugins: [stylesPlugin],
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
