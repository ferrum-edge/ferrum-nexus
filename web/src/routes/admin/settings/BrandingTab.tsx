import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactElement,
} from 'react';
import {
  MAX_BRANDING_FOOTER_LINKS,
  MAX_BRANDING_FOOTER_TEXT_LENGTH,
  MAX_BRANDING_LINK_LABEL_LENGTH,
  normalizeBrandingHexColor,
  type AdminSettingsResponse,
  type BrandingFontPreset,
  type BrandingLink,
  type BrandingLoginLayout,
  type BrandingRadius,
  type BrandingSidebarStyle,
  type ThemePreference,
} from '@ferrum-nexus/shared';
import { useUpdateAdminSettings } from '../../../hooks/useAdminSettings';
import { cn } from '../../../lib/cn';
import { deriveAccentScale, deriveInfoScale, parseHex } from '../../../lib/color';
import { fontStackFor, loadFontPreset } from '../../../lib/fonts';
import { useToast } from '../../../stores/toast';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { Icon } from '../../../components/ui/Icon';
import { Field, Input, LabeledInput, LabeledTextarea } from '../../../components/ui/Input';
import { LabeledSelect } from '../../../components/ui/Select';

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Follow the visitor’s system setting' },
];

const RADIUS_OPTIONS: ReadonlyArray<{ value: BrandingRadius; label: string; description: string }> =
  [
    { value: 'none', label: 'Square', description: 'No rounding anywhere.' },
    { value: 'sm', label: 'Subtle', description: 'Slightly softened corners.' },
    { value: 'md', label: 'Rounded', description: 'The default.' },
    { value: 'lg', label: 'Soft', description: 'Generous, friendly corners.' },
  ];

const FONT_OPTIONS: ReadonlyArray<{
  value: BrandingFontPreset;
  label: string;
  description: string;
}> = [
  { value: 'system', label: 'System', description: 'The visitor’s UI font; nothing to download.' },
  { value: 'inter', label: 'Inter', description: 'Neutral, highly legible; bundled.' },
  { value: 'manrope', label: 'Manrope', description: 'Geometric, a little warmer; bundled.' },
];

const SIDEBAR_OPTIONS: ReadonlyArray<{
  value: BrandingSidebarStyle;
  label: string;
  description: string;
}> = [
  { value: 'surface', label: 'Match surfaces', description: 'The rail follows the theme.' },
  {
    value: 'contrast',
    label: 'High contrast',
    description: 'An always-dark rail beside light or dark content.',
  },
];

const LOGIN_OPTIONS: ReadonlyArray<{
  value: BrandingLoginLayout;
  label: string;
  description: string;
}> = [
  { value: 'split', label: 'Split', description: 'Branded hero panel beside the form.' },
  { value: 'centered', label: 'Centered', description: 'The form alone.' },
];

const COLOR_ERROR = 'Use a 3- or 6-digit CSS hex colour, for example #fff or #2563eb.';

function colorFieldError(value: string): string | null {
  return normalizeBrandingHexColor(value) ? null : COLOR_ERROR;
}

const RADIUS_FACTOR: Readonly<Record<BrandingRadius, number>> = {
  none: 0,
  sm: 0.6,
  md: 1,
  lg: 1.5,
};

/** The form's current values, which the preview renders before they are saved. */
interface PreviewState {
  portalName: string;
  logo: string | null;
  primary: string;
  accent: string;
  radius: BrandingRadius;
  font: BrandingFontPreset;
  sidebar: BrandingSidebarStyle;
}

/**
 * A miniature of the shell in one theme, styled from the unsaved form values.
 *
 * Every token the real components read is overridden inline on the wrapper, so
 * the mock uses the same utilities as the app and shows exactly what saving
 * would produce — including the derived hover/foreground/tint colours.
 */
function ThemePreview({
  theme,
  state,
}: {
  theme: 'dark' | 'light';
  state: PreviewState;
}): ReactElement {
  const style = useMemo<CSSProperties>(() => {
    const vars: Record<string, string> = {
      '--radius-factor': String(RADIUS_FACTOR[state.radius]),
      fontFamily: fontStackFor(state.font),
    };
    const primary = parseHex(state.primary);
    const accent = parseHex(state.accent);
    if (primary) Object.assign(vars, deriveAccentScale(primary, theme));
    if (accent) Object.assign(vars, deriveInfoScale(accent, theme));
    return vars as CSSProperties;
  }, [state.primary, state.accent, state.radius, state.font, theme]);

  return (
    <div
      data-theme={theme}
      data-sidebar={state.sidebar}
      style={style}
      className="flex h-44 min-w-0 w-full max-w-full overflow-hidden rounded-lg border border-border bg-base text-fg shadow-card"
      aria-label={`${theme} theme preview`}
    >
      <div className="flex min-w-0 w-[38%] max-w-[38%] flex-col border-r border-sidebar-border bg-sidebar px-2.5 py-2.5 text-sidebar-fg">
        <div className="flex min-w-0 items-center gap-1.5">
          {state.logo ? (
            <img src={state.logo} alt="" className="h-4 w-4 shrink-0 rounded-sm object-contain" />
          ) : (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-accent text-[0.5rem] font-bold text-accent-fg">
              {state.portalName.trim().charAt(0).toUpperCase() || 'N'}
            </span>
          )}
          <span className="min-w-0 truncate text-[0.6rem] font-semibold text-sidebar-fg-strong">
            {state.portalName || 'Portal'}
          </span>
        </div>
        <div className="mt-3 flex min-w-0 flex-col gap-1">
          <span className="truncate rounded-sm bg-sidebar-active px-1.5 py-1 text-[0.55rem] font-medium text-sidebar-active-fg">
            Dashboard
          </span>
          <span className="truncate px-1.5 py-1 text-[0.55rem]">API catalog</span>
          <span className="truncate px-1.5 py-1 text-[0.55rem]">Credentials</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2.5">
        <div className="h-1.5 w-1/3 rounded-full bg-fg-subtle/40" />
        <div className="min-w-0 rounded-md border border-border bg-surface p-2 shadow-card">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[0.6rem] font-semibold">Billing API</span>
            <span className="shrink-0 rounded-full bg-success-soft px-1.5 text-[0.5rem] font-medium text-success ring-1 ring-success/25 ring-inset">
              Granted
            </span>
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-1">
            <span className="rounded-full bg-accent-soft px-1.5 text-[0.5rem] font-medium text-accent">
              v2.4.0
            </span>
            <span className="rounded-full bg-info-soft px-1.5 text-[0.5rem] font-medium text-info">
              API Key
            </span>
          </div>
        </div>
        <div className="mt-auto flex min-w-0 flex-wrap gap-1.5">
          <span className="rounded-md bg-accent px-2 py-1 text-[0.55rem] font-medium text-accent-fg">
            Request access
          </span>
          <span className="rounded-md border border-border bg-elevated px-2 py-1 text-[0.55rem] font-medium">
            Message
          </span>
        </div>
      </div>
    </div>
  );
}

function ColorField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
}): ReactElement {
  const swatch = normalizeBrandingHexColor(value);
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} className="min-w-0">
      <div data-testid={`${id}-row`} className="flex w-full min-w-0 max-w-full items-center gap-2">
        <span
          className="relative h-9 w-12 shrink-0 overflow-hidden rounded-md border border-border"
          style={{ backgroundColor: swatch ?? 'transparent' }}
        >
          <Input
            id={id}
            type="color"
            className="absolute inset-0 h-full w-full max-w-full cursor-pointer opacity-0"
            value={swatch ?? '#000000'}
            onChange={(event) => onChange(event.target.value)}
          />
        </span>
        <Input
          aria-label={`${label} hex value`}
          className="w-full min-w-0 max-w-full font-mono"
          value={value}
          invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </Field>
  );
}

/** The Branding tab of the admin settings page. */
export function BrandingTab({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const toast = useToast();
  const branding = settings.branding;
  const [portalName, setPortalName] = useState(branding.portal_name);
  const [tagline, setTagline] = useState(branding.tagline ?? '');
  const [supportEmail, setSupportEmail] = useState(branding.support_email ?? '');
  const [primaryColor, setPrimaryColor] = useState(branding.primary_color);
  const [accentColor, setAccentColor] = useState(branding.accent_color);
  const [primaryColorError, setPrimaryColorError] = useState<string | null>(null);
  const [accentColorError, setAccentColorError] = useState<string | null>(null);
  const [defaultTheme, setDefaultTheme] = useState<ThemePreference>(branding.default_theme);
  const [radius, setRadius] = useState<BrandingRadius>(branding.radius ?? 'md');
  const [fontPreset, setFontPreset] = useState<BrandingFontPreset>(
    branding.font_preset ?? 'system',
  );
  const [sidebarStyle, setSidebarStyle] = useState<BrandingSidebarStyle>(
    branding.sidebar_style ?? 'surface',
  );
  const [loginLayout, setLoginLayout] = useState<BrandingLoginLayout>(
    branding.login_layout ?? 'split',
  );
  const [footerText, setFooterText] = useState(branding.footer_text ?? '');
  const [footerLinks, setFooterLinks] = useState<BrandingLink[]>(branding.footer_links ?? []);
  const [logo, setLogo] = useState<string | null>(branding.logo_data_url);
  const [logoError, setLogoError] = useState<string | null>(null);

  // Load a bundled face as soon as it is picked so the preview shows it.
  useEffect(() => {
    void loadFontPreset(fontPreset);
  }, [fontPreset]);

  const onLogo = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 256 * 1024) {
      setLogoError('Logos must be smaller than 256 KB.');
      return;
    }
    setLogoError(null);
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') setLogo(reader.result);
    });
    reader.readAsDataURL(file);
  };

  const updateLink = (index: number, patch: Partial<BrandingLink>): void => {
    setFooterLinks((links) => links.map((link, i) => (i === index ? { ...link, ...patch } : link)));
  };

  const preview: PreviewState = {
    portalName,
    logo,
    primary: primaryColor,
    accent: accentColor,
    radius,
    font: fontPreset,
    sidebar: sidebarStyle,
  };

  const onPrimaryColor = (value: string): void => {
    setPrimaryColor(value);
    if (primaryColorError) setPrimaryColorError(colorFieldError(value));
  };

  const onAccentColor = (value: string): void => {
    setAccentColor(value);
    if (accentColorError) setAccentColorError(colorFieldError(value));
  };

  const save = (): void => {
    const nextPrimaryError = colorFieldError(primaryColor);
    const nextAccentError = colorFieldError(accentColor);
    setPrimaryColorError(nextPrimaryError);
    setAccentColorError(nextAccentError);
    if (nextPrimaryError || nextAccentError) return;
    const primary = normalizeBrandingHexColor(primaryColor);
    const accent = normalizeBrandingHexColor(accentColor);
    if (!primary || !accent) return;
    update.mutate(
      {
        branding: {
          portal_name: portalName.trim(),
          tagline: tagline.trim() || null,
          support_email: supportEmail.trim() || null,
          primary_color: primary,
          accent_color: accent,
          default_theme: defaultTheme,
          logo_data_url: logo,
          radius,
          font_preset: fontPreset,
          sidebar_style: sidebarStyle,
          login_layout: loginLayout,
          footer_text: footerText.trim() || null,
          footer_links: footerLinks
            .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
            .filter((link) => link.label !== '' || link.url !== ''),
        },
      },
      { onSuccess: () => toast.success('Branding saved') },
    );
  };

  return (
    <div
      data-testid="branding-layout"
      className="grid min-w-0 w-full max-w-full gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
    >
      <div className="flex min-w-0 w-full max-w-full flex-col gap-6">
        <Card className="min-w-0 w-full max-w-full">
          <CardHeader
            icon="palette"
            title="Identity"
            description="Shown on the sign-in page, the shell and in every email."
          />
          <CardBody className="grid min-w-0 gap-5 md:grid-cols-2 [&>*]:min-w-0">
            <LabeledInput
              label="Portal name"
              value={portalName}
              onChange={(event) => setPortalName(event.target.value)}
            />
            <LabeledInput
              label="Support email"
              type="email"
              value={supportEmail}
              onChange={(event) => setSupportEmail(event.target.value)}
              hint="Linked from the footer and the sign-in page."
            />
            <LabeledTextarea
              className="md:col-span-2"
              label="Tagline"
              rows={2}
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
              hint="The headline of the sign-in hero. Leave empty for the default."
            />
            <Field
              label="Logo"
              htmlFor="logo-upload"
              error={logoError}
              hint="PNG or SVG, under 256 KB. Also used as the browser tab icon."
              className="md:col-span-2"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-inset">
                  {logo ? (
                    <img src={logo} alt="Current logo" className="h-10 w-10 object-contain" />
                  ) : (
                    <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg">
                      {portalName.trim().charAt(0).toUpperCase() || 'N'}
                    </span>
                  )}
                </span>
                <label
                  htmlFor="logo-upload"
                  className={cn(
                    'inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-dashed border-border-strong px-3.5 text-sm font-medium text-fg-muted',
                    'transition-colors hover:border-accent hover:bg-accent-soft/40 hover:text-fg',
                    'focus-within:ring-2 focus-within:ring-accent-ring',
                  )}
                >
                  <Icon name="upload" />
                  {logo ? 'Replace logo' : 'Upload logo'}
                  {/* A bare input: the styled label is the visible control, and
                      the primitive's `w-full` would fight `sr-only`. */}
                  <input
                    id="logo-upload"
                    type="file"
                    accept="image/*"
                    onChange={onLogo}
                    className="sr-only"
                  />
                </label>
                {logo ? (
                  <Button variant="ghost" size="sm" onClick={() => setLogo(null)}>
                    <Icon name="trash" />
                    Remove
                  </Button>
                ) : null}
              </div>
            </Field>
          </CardBody>
        </Card>

        <Card className="min-w-0 w-full max-w-full">
          <CardHeader
            icon="layout"
            title="Appearance"
            description="Colours and presets every page is built from. The preview updates as you edit."
          />
          <CardBody className="grid min-w-0 gap-5 md:grid-cols-2 [&>*]:min-w-0">
            <ColorField
              id="primary-color"
              label="Primary colour"
              value={primaryColor}
              onChange={onPrimaryColor}
              error={primaryColorError}
              hint="Buttons, active navigation and focus rings; shades and tints are derived from it."
            />
            <ColorField
              id="accent-color"
              label="Accent colour"
              value={accentColor}
              onChange={onAccentColor}
              error={accentColorError}
              hint="Secondary emphasis: informational badges and the sign-in glow."
            />
            <LabeledSelect<ThemePreference>
              label="Default theme"
              value={defaultTheme}
              onValueChange={setDefaultTheme}
              options={THEME_OPTIONS.map((option) => ({ ...option }))}
              hint="Applies until a visitor picks a theme themselves."
            />
            <LabeledSelect<BrandingRadius>
              label="Corners"
              value={radius}
              onValueChange={setRadius}
              options={RADIUS_OPTIONS.map((option) => ({ ...option }))}
            />
            <LabeledSelect<BrandingFontPreset>
              label="Typeface"
              value={fontPreset}
              onValueChange={setFontPreset}
              options={FONT_OPTIONS.map((option) => ({ ...option }))}
            />
            <LabeledSelect<BrandingSidebarStyle>
              label="Navigation rail"
              value={sidebarStyle}
              onValueChange={setSidebarStyle}
              options={SIDEBAR_OPTIONS.map((option) => ({ ...option }))}
            />
            <LabeledSelect<BrandingLoginLayout>
              label="Sign-in layout"
              value={loginLayout}
              onValueChange={setLoginLayout}
              options={LOGIN_OPTIONS.map((option) => ({ ...option }))}
            />
          </CardBody>
        </Card>

        <Card className="min-w-0 w-full max-w-full">
          <CardHeader
            icon="link"
            title="Footer"
            description="An optional legal line and links shown in the shell footer and on the sign-in page."
          />
          <CardBody className="flex min-w-0 flex-col gap-5">
            <LabeledInput
              label="Footer text"
              placeholder="© 2026 Acme Corp. All rights reserved."
              maxLength={MAX_BRANDING_FOOTER_TEXT_LENGTH}
              value={footerText}
              onChange={(event) => setFooterText(event.target.value)}
            />
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-fg">Footer links</p>
                <span className="text-xs text-fg-subtle">
                  {footerLinks.length}/{MAX_BRANDING_FOOTER_LINKS}
                </span>
              </div>
              {footerLinks.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  No links yet. Terms, privacy policy and documentation are the usual ones.
                </p>
              ) : null}
              {footerLinks.map((link, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]"
                >
                  <Input
                    aria-label={`Link ${index + 1} label`}
                    placeholder="Label"
                    maxLength={MAX_BRANDING_LINK_LABEL_LENGTH}
                    className="min-w-0 w-full max-w-full"
                    value={link.label}
                    onChange={(event) => updateLink(index, { label: event.target.value })}
                  />
                  <Input
                    aria-label={`Link ${index + 1} URL`}
                    placeholder="https://"
                    type="url"
                    className="col-span-2 min-w-0 w-full max-w-full sm:col-span-1"
                    value={link.url}
                    onChange={(event) => updateLink(index, { url: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove link ${index + 1}`}
                    className="col-start-2 row-start-1 sm:col-start-3"
                    onClick={() => setFooterLinks((links) => links.filter((_, i) => i !== index))}
                  >
                    <Icon name="x" />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={footerLinks.length >= MAX_BRANDING_FOOTER_LINKS}
                  onClick={() => setFooterLinks((links) => [...links, { label: '', url: '' }])}
                >
                  <Icon name="plus" />
                  Add link
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>

        <div>
          <Button variant="primary" loading={update.isPending} onClick={save}>
            Save branding
          </Button>
        </div>
      </div>

      <aside
        data-testid="branding-preview"
        className="min-w-0 w-full max-w-full xl:sticky xl:top-24 xl:self-start"
      >
        <Card className="min-w-0 w-full max-w-full overflow-hidden">
          <CardHeader
            icon="eye"
            title="Preview"
            description="Both themes, from the values in the form."
          />
          <CardBody className="flex min-w-0 flex-col gap-4 overflow-x-auto">
            <div>
              <p className="mb-1.5 text-xs font-medium tracking-wide text-fg-subtle uppercase">
                Dark
              </p>
              <ThemePreview theme="dark" state={preview} />
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium tracking-wide text-fg-subtle uppercase">
                Light
              </p>
              <ThemePreview theme="light" state={preview} />
            </div>
            <p className="text-xs leading-relaxed text-fg-subtle">
              Visitors see the default theme first; the header toggle lets them switch.
            </p>
          </CardBody>
        </Card>
      </aside>
    </div>
  );
}
