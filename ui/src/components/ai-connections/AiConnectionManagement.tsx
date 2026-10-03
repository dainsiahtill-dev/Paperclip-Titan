import { v3t } from "@/i18n";
import { Button } from "@/components/ui/button";

export function AiConnectionLegacyNotice({
  onAdopt,
  readOnly = false,
}: {
  onAdopt: () => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">
        {v3t("local.existing_authentication_not_managed_by_connections_c836e5")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {v3t("local.this_agent_keeps_its_current_authentication_until_you_ch_c88eb3")}
      </p>
      {!readOnly && (
        <Button variant="outline" className="self-start" onClick={onAdopt}>
          {v3t("local.choose_a_managed_connection_7efd02")}
        </Button>
      )}
    </div>
  );
}
