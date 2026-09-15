import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Field, Input } from '../ui/Input';

export interface PasswordFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'children'
> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

/**
 * A password input with a local reveal toggle.
 *
 * The control stays `type="password"` until the visitor asks for it, so a
 * password manager and a shoulder-surfer both see what they expect; the toggle
 * is a {@link Button} rather than a bare element so it inherits the focus ring.
 */
export function PasswordField({
  label,
  hint,
  error,
  required,
  className,
  ...rest
}: PasswordFieldProps): ReactElement {
  const generatedId = useId();
  const id = rest.id ?? generatedId;
  const [revealed, setRevealed] = useState(false);

  return (
    <Field label={label} htmlFor={id} hint={hint} error={error} required={required}>
      <div className="relative">
        <Input
          id={id}
          type={revealed ? 'text' : 'password'}
          required={required}
          invalid={Boolean(error)}
          className={className ? `pr-11 ${className}` : 'pr-11'}
          {...rest}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-1/2 right-1 -translate-y-1/2"
          aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={revealed}
          onClick={() => setRevealed((current) => !current)}
        >
          <Icon name={revealed ? 'eye-off' : 'eye'} className="h-4 w-4" />
        </Button>
      </div>
    </Field>
  );
}
