import { useEffect, useState } from "react";
import { inputCls } from "./ui.js";

export interface ModelChoiceProps {
  value: string;
  onChange: (value: string) => void;
  models: string[];
  disabled: boolean;
  placeholder: string;
  allowEmpty?: boolean;
  testId: string;
}

/** Explicit model selector: unlike a datalist it always exposes the complete discovered list. */
export default function ModelChoice({
  value,
  onChange,
  models,
  disabled,
  placeholder,
  allowEmpty = false,
  testId,
}: ModelChoiceProps) {
  const [manual, setManual] = useState(false);
  const listed = models.includes(value.trim());
  useEffect(() => {
    if (listed) setManual(false);
  }, [listed]);

  if (models.length === 0 || manual || (!listed && value.trim())) {
    return (
      <div className="space-y-2">
        {models.length > 0 && (
          <select
            value="__manual__"
            onChange={(event) => {
              const next = event.target.value;
              if (next === "__manual__") setManual(true);
              else {
                setManual(false);
                onChange(next);
              }
            }}
            disabled={disabled}
            data-testid={`${testId}-select`}
            className={`${inputCls} font-mono text-xs`}
          >
            {allowEmpty && <option value="">关闭备用模型</option>}
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            <option value="__manual__">手动填写其他模型…</option>
          </select>
        )}
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          spellCheck={false}
          data-testid={`${testId}-input`}
          className={`${inputCls} font-mono text-xs`}
        />
      </div>
    );
  }

  return (
    <select
      value={listed ? value.trim() : ""}
      onChange={(event) => {
        const next = event.target.value;
        if (next === "__manual__") setManual(true);
        else {
          setManual(false);
          onChange(next);
        }
      }}
      disabled={disabled}
      data-testid={`${testId}-select`}
      className={`${inputCls} font-mono text-xs`}
    >
      {allowEmpty && <option value="">关闭备用模型</option>}
      {!allowEmpty && !listed && <option value="">选择一个模型</option>}
      {models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
      <option value="__manual__">手动填写其他模型…</option>
    </select>
  );
}
