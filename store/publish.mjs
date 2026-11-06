import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { api, list, patch, profile } from './asc.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const listing = JSON.parse(readFileSync(resolve(root, 'store/listing.zh-Hans.json'), 'utf8'));
const output = resolve(root, 'client/build/ios');
mkdirSync(output, { recursive: true });
const save = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n');

async function context() {
  const app = (await api(`/v1/apps/${profile.appId}`)).data;
  if (app.attributes.bundleId !== 'com.nzx.panecast') throw new Error('This listing is only for Panecast');
  const versions = await list(`/v1/apps/${app.id}/appStoreVersions`, { limit: 100 });
  const version = versions.find((v) => v.attributes.platform === 'IOS' && v.attributes.appStoreState === 'PREPARE_FOR_SUBMISSION');
  if (!version) throw new Error('No editable iOS App Store draft');
  const locales = await list(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, { limit: 100 });
  const localization = locales.find((l) => l.attributes.locale === listing.locale);
  if (!localization) throw new Error('Simplified Chinese localization is missing');
  return { app, version, localization };
}

async function metadata() {
  for (const [field, limit] of Object.entries({ name: 30, subtitle: 30, promotionalText: 170, keywords: 100, description: 4000 })) {
    if (Array.from(listing[field]).length > limit) throw new Error(`${field} exceeds ${limit} characters`);
  }
  for (const field of ['supportUrl', 'privacyPolicyUrl', 'marketingUrl']) {
    const response = await fetch(listing[field], { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${field} is not publicly available`);
  }
  const ctx = await context();
  const infos = await list(`/v1/apps/${ctx.app.id}/appInfos`, { limit: 100 });
  const info = infos.find((i) => (i.attributes.state ?? i.attributes.appStoreState) === 'PREPARE_FOR_SUBMISSION');
  if (!info) throw new Error('No editable app information');
  const infoLocales = await list(`/v1/appInfos/${info.id}/appInfoLocalizations`, { limit: 100 });
  const infoLocale = infoLocales.find((l) => l.attributes.locale === listing.locale);
  if (!infoLocale) throw new Error('App information localization is missing');
  const betaLocales = await list(`/v1/apps/${ctx.app.id}/betaAppLocalizations`, { limit: 100 });
  save('store-metadata-before.json', { ...ctx, info, infoLocale, betaLocales });
  await patch('appStoreVersions', ctx.version.id, { versionString: listing.version, copyright: listing.copyright });
  await patch('appStoreVersionLocalizations', ctx.localization.id, Object.fromEntries(['description', 'keywords', 'promotionalText', 'supportUrl', 'marketingUrl'].map((name) => [name, listing[name]])));
  await patch('appInfoLocalizations', infoLocale.id, { name: listing.name, subtitle: listing.subtitle, privacyPolicyUrl: listing.privacyPolicyUrl });
  const categories = await list('/v1/appCategories', { limit: 200 });
  const category = categories.find((c) => c.id === 'DEVELOPER_TOOLS');
  if (category) await patch('appInfos', info.id, undefined, { primaryCategory: { data: { type: 'appCategories', id: category.id } } });
  const betaLocale = betaLocales.find((l) => l.attributes.locale === listing.locale);
  if (betaLocale) await patch('betaAppLocalizations', betaLocale.id, { description: listing.betaDescription });
  else await api('/v1/betaAppLocalizations', { method: 'POST', body: { data: { type: 'betaAppLocalizations', attributes: { locale: listing.locale, description: listing.betaDescription }, relationships: { app: { data: { type: 'apps', id: ctx.app.id } } } } } });
  const result = { appId: ctx.app.id, version: (await api(`/v1/appStoreVersions/${ctx.version.id}`)).data, localization: (await api(`/v1/appStoreVersionLocalizations/${ctx.localization.id}`)).data, appInfoLocalization: (await api(`/v1/appInfoLocalizations/${infoLocale.id}`)).data };
  save('store-metadata-after.json', result);
  console.log(JSON.stringify({ appId: ctx.app.id, version: result.version.attributes.versionString, locale: listing.locale, descriptionLength: listing.description.length, state: result.version.attributes.appStoreState }));
}

async function screenshots(deadline = Date.now() + 10 * 60_000) {
  const ctx = await context();
  const manifest = JSON.parse(readFileSync(resolve(root, 'store/screenshots/manifest.json'), 'utf8'));
  const library = (await api(`/v1/apps/${ctx.app.id}/assetLibrary`)).data;
  const ref = (await api('/v1/appAssetLibraryRefData')).data[0].attributes;
  const screenshotType = ref.placementTypes.find((t) => t.placementTypeId === 'APP_SCREENSHOT');
  const feature = ref.features.find((f) => f.featureId === 'APP_STORE_VERSIONS');
  save('store-asset-reference.json', { libraryId: library.id, ref, feature });
  const uploaded = [];
  const reservations = [];
  let pending = false;
  for (const group of manifest.groups) {
    const profileGroup = ref.placementProfileGroups.find((g) => g.displayClassId === group.displayClass && g.platform === group.platform);
    if (!profileGroup) throw new Error(`No placement group for ${group.displayClass}`);
    const mapping = screenshotType.specMappings.find((m) => m.placementGroupId === profileGroup.placementProfileGroupId);
    const spec = ref.imageSpecs.find((s) => mapping.specs.includes(s.specId) && s.dimensions.minWidth === group.width && s.dimensions.minHeight === group.height);
    if (!spec || spec.alphaAllowed) throw new Error(`Unsupported opaque screenshot dimensions for ${group.displayClass}`);
    const orderedPlacements = [];
    let groupPending = false;
    for (const relative of group.files) {
      const path = resolve(root, relative);
      const bytes = readFileSync(path);
      if (bytes.readUInt32BE(16) !== group.width || bytes.readUInt32BE(20) !== group.height || bytes[25] !== 2) throw new Error(`Expected an opaque RGB PNG: ${relative}`);
      const referencePrefix = `${listing.locale}/${group.displayClass}/${basename(path)}#`;
      const referenceName = referencePrefix + createHash('sha256').update(bytes).digest('hex').slice(0, 12);
      const existing = await list(`/v1/appAssetLibraries/${library.id}/images`, { 'filter[referenceName]': referenceName, limit: 200 });
      let asset = existing.find((a) => a.attributes.referenceName === referenceName && ['PREPARE_FOR_SUBMISSION', 'APPROVED', 'UPLOAD_COMPLETE', 'AWAITING_UPLOAD'].includes(a.attributes.state));
      if (!asset) {
        asset = (await api('/v1/appAssetLibraryImages', { method: 'POST', body: { data: { type: 'appAssetLibraryImages', attributes: { fileName: basename(path), fileSize: bytes.length, category: 'APP_SCREENSHOTS_AND_PREVIEWS', referenceName }, relationships: { assetLibrary: { data: { type: 'appAssetLibraries', id: library.id } } } } } })).data;
      }
      if (asset.attributes.state === 'AWAITING_UPLOAD') {
        for (const op of asset.attributes.uploadOperations) {
          const url = new URL(op.url);
          if (url.protocol !== 'https:' || !url.hostname.endsWith('.apple.com')) throw new Error('Unexpected Apple asset upload host');
          const response = await fetch(url, { method: op.method, headers: Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value])), body: bytes.subarray(op.offset, op.offset + op.length), signal: AbortSignal.timeout(60_000), redirect: 'error' });
          if (!response.ok) throw new Error(`Asset bytes upload failed: HTTP ${response.status}`);
        }
        await patch('appAssetLibraryImages', asset.id, { uploaded: true });
      }
      asset = (await api(`/v1/appAssetLibraryImages/${asset.id}`)).data;
      reservations.push({ file: relative, assetId: asset.id, state: asset.attributes.state });
      save('store-asset-reservations.json', reservations);
      if (asset.attributes.state === 'FAILED') throw new Error(`Asset processing failed: ${relative}: ${JSON.stringify(asset.attributes.stateDetails)}`);
      if (!['PREPARE_FOR_SUBMISSION', 'APPROVED'].includes(asset.attributes.state)) {
        // Apple permits placements while an uploaded image is being processed.
        // Attach it to the editable draft, then verify processing on a later pass.
        if (asset.attributes.state === 'UPLOAD_COMPLETE') {
          const existingPlacements = await list(`/v1/appAssetLibraryImages/${asset.id}/placements`, { 'filter[appStoreVersionLocalization]': ctx.localization.id, 'filter[placementGroup]': profileGroup.placementProfileGroupId, limit: 200 });
          if (!existingPlacements.some((p) => p.attributes.placementType === 'APP_SCREENSHOT')) {
            await api('/v1/appAssetLibraryPlacements', { method: 'POST', body: { data: { type: 'appAssetLibraryPlacements', attributes: { placementType: 'APP_SCREENSHOT', placementGroup: profileGroup.placementProfileGroupId }, relationships: { image: { data: { type: 'appAssetLibraryImages', id: asset.id } }, appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: ctx.localization.id } } } } } });
          }
        }
        pending = true;
        groupPending = true;
        console.log(JSON.stringify({ file: relative, assetId: asset.id, state: asset.attributes.state }));
        continue;
      }
      if (!['PREPARE_FOR_SUBMISSION', 'APPROVED'].includes(asset.attributes.state) || asset.attributes.specId !== spec.specId) throw new Error(`Asset processing or dimensions did not match: ${relative}`);
      const placements = await list(`/v1/appAssetLibraryImages/${asset.id}/placements`, { 'filter[appStoreVersionLocalization]': ctx.localization.id, 'filter[placementGroup]': profileGroup.placementProfileGroupId, limit: 200 });
      let placement = placements.find((p) => p.attributes.placementType === 'APP_SCREENSHOT');
      if (!placement) placement = (await api('/v1/appAssetLibraryPlacements', { method: 'POST', body: { data: { type: 'appAssetLibraryPlacements', attributes: { placementType: 'APP_SCREENSHOT', placementGroup: profileGroup.placementProfileGroupId }, relationships: { image: { data: { type: 'appAssetLibraryImages', id: asset.id } }, appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: ctx.localization.id } } } } } })).data;
      const current = await api(`/v1/appStoreVersionLocalizations/${ctx.localization.id}/placements`, { query: { 'filter[placementType]': 'APP_SCREENSHOT', 'filter[placementGroup]': profileGroup.placementProfileGroupId, include: 'image', limit: 200 } });
      const replaced = new Set((current.included ?? []).filter((i) => i.type === 'appAssetLibraryImages' && i.id !== asset.id && i.attributes.referenceName?.startsWith(referencePrefix)).map((i) => i.id));
      for (const old of current.data) if (replaced.has(old.relationships?.image?.data?.id)) await api(`/v1/appAssetLibraryPlacements/${old.id}`, { method: 'DELETE' });
      orderedPlacements.push({ type: 'appAssetLibraryPlacements', id: placement.id });
      uploaded.push({ file: relative, assetId: asset.id, placementId: placement.id, state: asset.attributes.state, dimensions: [asset.attributes.imageAsset.width, asset.attributes.imageAsset.height], placementGroup: profileGroup.placementProfileGroupId });
      save('store-screenshot-upload.json', uploaded);
      console.log(JSON.stringify(uploaded.at(-1)));
    }
    if (groupPending) continue;
    const allPlacements = await list(`/v1/appStoreVersionLocalizations/${ctx.localization.id}/placements`, { 'filter[placementType]': 'APP_SCREENSHOT', 'filter[placementGroup]': profileGroup.placementProfileGroupId, sort: 'placementGroupPosition', limit: 200 });
    for (const p of allPlacements) if (!orderedPlacements.some((v) => v.id === p.id)) orderedPlacements.push({ type: 'appAssetLibraryPlacements', id: p.id });
    await api('/v1/appAssetLibraryPlacementOrderingRequests', { method: 'POST', body: { data: { type: 'appAssetLibraryPlacementOrderingRequests', attributes: { placementGroup: profileGroup.placementProfileGroupId }, relationships: { orderedPlacements: { data: orderedPlacements }, appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: ctx.localization.id } } } } } });
    const verified = await list(`/v1/appStoreVersionLocalizations/${ctx.localization.id}/placements`, { 'filter[placementType]': 'APP_SCREENSHOT', 'filter[placementGroup]': profileGroup.placementProfileGroupId, sort: 'placementGroupPosition', limit: 200 });
    if (verified.map((p) => p.id).join() !== orderedPlacements.map((p) => p.id).join()) throw new Error('Screenshot order verification failed');
  }
  if (pending) {
    if (Date.now() >= deadline) throw new Error('Apple is still processing screenshots; rerun to resume the existing reservations.');
    console.log('Waiting for Apple image processing; uploaded files will be reused.');
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return screenshots(deadline);
  }
}

async function attachBuild(buildNumber) {
  if (!buildNumber) throw new Error('Pass the uploaded build number');
  const ctx = await context();
  const builds = await list('/v1/builds', { 'filter[app]': ctx.app.id, 'filter[version]': buildNumber, 'filter[preReleaseVersion.version]': listing.version, include: 'buildBetaDetail', limit: 100 });
  const build = builds.find((b) => b.attributes.processingState === 'VALID' && !b.attributes.expired);
  if (!build) throw new Error('Build is not processed and valid yet');
  await patch('appStoreVersions', ctx.version.id, undefined, { build: { data: { type: 'builds', id: build.id } } });
  const locales = await list(`/v1/builds/${build.id}/betaBuildLocalizations`, { limit: 100 });
  const locale = locales.find((l) => l.attributes.locale === listing.locale);
  if (locale) await patch('betaBuildLocalizations', locale.id, { whatsNew: listing.whatToTest });
  else await api('/v1/betaBuildLocalizations', { method: 'POST', body: { data: { type: 'betaBuildLocalizations', attributes: { locale: listing.locale, whatsNew: listing.whatToTest }, relationships: { build: { data: { type: 'builds', id: build.id } } } } } });
  const group = profile.internalTesting?.groupId;
  if (!group) throw new Error('No configured internal testing group');
  await api(`/v1/betaGroups/${group}/relationships/builds`, { method: 'POST', body: { data: [{ type: 'builds', id: build.id }] } });
  const detail = (await api(`/v1/builds/${build.id}/buildBetaDetail`)).data;
  save('store-new-build.json', { build, detail, groupId: group });
  console.log(JSON.stringify({ buildId: build.id, version: listing.version, buildNumber, internalBuildState: detail.attributes.internalBuildState }));
}

const action = process.argv[2];
if (action === 'metadata') await metadata();
else if (action === 'screenshots') await screenshots();
else if (action === 'attach-build') await attachBuild(process.argv[3]);
else throw new Error('Usage: node store/publish.mjs metadata|screenshots|attach-build <number>');
