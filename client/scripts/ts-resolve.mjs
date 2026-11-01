// Lets Node run the app's TypeScript modules directly (with
// --experimental-transform-types): resolves extensionless relative imports to
// `.ts` files, the way Metro and Jest do.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        try {
          return await next(specifier, context);
        } catch (error) {
          if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) {
            return next(specifier + '.ts', context);
          }
          throw error;
        }
      }
    `),
  import.meta.url,
);
