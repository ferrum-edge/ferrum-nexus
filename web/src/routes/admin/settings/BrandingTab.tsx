import { useState, type ChangeEvent, type ReactElement } from 'react';
import type { AdminSettingsResponse, ThemePreference } from '@ferrum-nexus/shared';
import { useUpdateAdminSettings } from '../../../hooks/useAdminSettings';
import { useToast } from '../../../stores/toast';
import { Button } from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import { Field, Input, LabeledInput, LabeledTextarea } from '../../../components/ui/Input';
import { LabeledSelect } from '../../../components/ui/Select';

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Follow the visitor’s system setting' },
];

/** The Branding tab of the admin settings page. */
export function BrandingTab({ settings }: { settings: AdminSettingsResponse }): ReactElement {
  const update = useUpdateAdminSettings();
  const toast = useToast();
  const [portalName, setPortalName] = useState(settings.branding.portal_name);
  const [tagline, setTagline] = useState(settings.branding.tagline ?? '');
  const [supportEmail, setSupportEmail] = useState(settings.branding.support_email ?? '');
  const [primaryColor, setPrimaryColor] = useState(settings.branding.primary_color);
  const [accentColor, setAccentColor] = useState(settings.branding.accent_color);
  const [defaultTheme, setDefaultTheme] = useState<ThemePreference>(
    settings.branding.default_theme,
  );
  const [logo, setLogo] = useState<string | null>(settings.branding.logo_data_url);
  const [logoError, setLogoError] = useState<string | null>(null);

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

  return (
    <Card>
      <CardHeader title="Branding" description="Shown on the sign-in page, the shell and emails." />
      <CardBody className="grid gap-5 md:grid-cols-2">
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
        />
        <LabeledTextarea
          className="md:col-span-2"
          label="Tagline"
          rows={2}
          value={tagline}
          onChange={(event) => setTagline(event.target.value)}
        />
        <Field label="Primary colour" htmlFor="primary-color" hint="Used for the accent tokens.">
          <div className="flex items-center gap-2">
            <Input
              id="primary-color"
              type="color"
              className="h-9 w-16 p-1"
              value={primaryColor}
              onChange={(event) => setPrimaryColor(event.target.value)}
            />
            <Input
              aria-label="Primary colour hex value"
              value={primaryColor}
              onChange={(event) => setPrimaryColor(event.target.value)}
            />
          </div>
        </Field>
        <Field label="Accent colour" htmlFor="accent-color">
          <div className="flex items-center gap-2">
            <Input
              id="accent-color"
              type="color"
              className="h-9 w-16 p-1"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
            />
            <Input
              aria-label="Accent colour hex value"
              value={accentColor}
              onChange={(event) => setAccentColor(event.target.value)}
            />
          </div>
        </Field>
        <LabeledSelect<ThemePreference>
          label="Default theme"
          value={defaultTheme}
          onValueChange={setDefaultTheme}
          options={THEME_OPTIONS.map((option) => ({ ...option }))}
        />
        <Field
          label="Logo"
          htmlFor="logo-upload"
          error={logoError}
          hint="PNG or SVG, under 256 KB."
        >
          <div className="flex items-center gap-3">
            {logo ? (
              <img src={logo} alt="Current logo" className="h-10 w-10 rounded-md object-contain" />
            ) : (
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg">
                N
              </span>
            )}
            <Input id="logo-upload" type="file" accept="image/*" onChange={onLogo} />
            {logo ? (
              <Button variant="ghost" size="sm" onClick={() => setLogo(null)}>
                Remove
              </Button>
            ) : null}
          </div>
        </Field>

        <div className="md:col-span-2">
          <Button
            variant="primary"
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                {
                  branding: {
                    portal_name: portalName.trim(),
                    tagline: tagline.trim() || null,
                    support_email: supportEmail.trim() || null,
                    primary_color: primaryColor,
                    accent_color: accentColor,
                    default_theme: defaultTheme,
                    logo_data_url: logo,
                  },
                },
                { onSuccess: () => toast.success('Branding saved') },
              )
            }
          >
            Save branding
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
