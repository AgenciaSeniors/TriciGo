import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Text } from './Text';
import { Ionicons } from '@expo/vector-icons';

// ============================================================
// HistoryFilters — Collapsible filter bar for ride/trip history
// ============================================================

export interface HistoryFilterState {
  status?: ('completed' | 'canceled')[];
  serviceType?: string;
  paymentMethod?: string;
  dateFrom?: string; // ISO date string
  dateTo?: string;
}

export interface HistoryFiltersProps {
  /** Current filter state */
  filters: HistoryFilterState;
  /** Callback when any filter changes */
  onFilterChange: (filters: HistoryFilterState) => void;
  /** Available service type options */
  serviceTypes?: { value: string; label: string }[];
  /** Available payment method options */
  paymentMethods?: { value: string; label: string }[];
  /** i18n labels */
  labels: {
    filters: string;
    all: string;
    completed: string;
    canceled: string;
    serviceType: string;
    paymentMethod: string;
    clearFilters: string;
  };
  /** Dark mode (driver app) */
  dark?: boolean;
}

function Chip({
  label,
  active,
  onPress,
  dark,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  dark?: boolean;
}) {
  const bgActive = dark ? 'bg-primary-600' : 'bg-primary-500';
  const bgInactive = dark ? 'bg-neutral-800' : 'bg-neutral-100';
  const textColor = active ? 'white' : dark ? 'secondary' : 'primary';

  return (
    <Pressable
      onPress={onPress}
      className={`px-3 py-1.5 rounded-full mr-2 ${active ? bgActive : bgInactive}`}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Text
        variant="caption"
        color={textColor as any}
        className={active ? 'font-semibold text-white' : 'font-medium'}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function DropdownChip({
  label,
  options,
  value,
  onChange,
  dark,
}: {
  label: string;
  options: { value: string; label: string }[];
  value?: string;
  onChange: (value: string | undefined) => void;
  dark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = value != null;
  const selectedLabel = options.find((o) => o.value === value)?.label;

  return (
    <View className="mr-2">
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel={selectedLabel ?? label}
        accessibilityState={{ expanded: open }}
        className={`px-3 py-1.5 rounded-full flex-row items-center ${
          active
            ? dark
              ? 'bg-primary-600'
              : 'bg-primary-500'
            : dark
              ? 'bg-neutral-800'
              : 'bg-neutral-100'
        }`}
      >
        <Text
          variant="caption"
          color={active ? 'white' : dark ? 'secondary' : 'primary'}
          className={active ? 'font-semibold text-white' : 'font-medium'}
        >
          {selectedLabel ?? label}
        </Text>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={12}
          color={active ? '#fff' : dark ? '#9ca3af' : '#6b7280'}
          style={{ marginLeft: 4 }}
        />
      </Pressable>
      {open && (
        <View
          className={`absolute top-10 left-0 z-50 rounded-lg shadow-lg min-w-[140px] ${
            dark ? 'bg-neutral-800' : 'bg-white'
          }`}
        >
          {options.map((opt) => (
            <Pressable
              key={opt.value}
              onPress={() => {
                onChange(opt.value === value ? undefined : opt.value);
                setOpen(false);
              }}
              accessibilityRole="menuitem"
              accessibilityLabel={opt.label}
              accessibilityState={{ selected: opt.value === value }}
              className={`px-3 py-2 ${
                opt.value === value
                  ? dark
                    ? 'bg-neutral-700'
                    : 'bg-primary-50'
                  : ''
              }`}
            >
              <Text
                variant="caption"
                color={dark ? 'white' : 'primary'}
                className="font-medium"
              >
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

export function HistoryFilters({
  filters,
  onFilterChange,
  serviceTypes,
  paymentMethods,
  labels,
  dark = false,
}: HistoryFiltersProps) {
  const [expanded, setExpanded] = useState(false);

  const hasActiveFilters =
    (filters.status && filters.status.length > 0 && filters.status.length < 2) ||
    filters.serviceType ||
    filters.paymentMethod;

  const handleStatusChange = useCallback(
    (status?: ('completed' | 'canceled')[]) => {
      onFilterChange({ ...filters, status });
    },
    [filters, onFilterChange],
  );

  const clearFilters = useCallback(() => {
    onFilterChange({});
  }, [onFilterChange]);

  const currentStatuses = filters.status;
  const isAll = !currentStatuses || currentStatuses.length === 0 || currentStatuses.length === 2;
  const isCompleted =
    currentStatuses?.length === 1 && currentStatuses[0] === 'completed';
  const isCanceled =
    currentStatuses?.length === 1 && currentStatuses[0] === 'canceled';

  return (
    <View className={`px-4 py-2 ${dark ? 'bg-neutral-900' : 'bg-white'}`}>
      {/* Header row */}
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center justify-between py-1"
        accessibilityRole="button"
        accessibilityLabel={labels.filters}
        accessibilityState={{ expanded }}
      >
        <View className="flex-row items-center gap-2">
          <Ionicons
            name="filter-outline"
            size={16}
            color={dark ? '#d1d5db' : '#374151'}
          />
          <Text
            variant="bodySmall"
            color={dark ? 'white' : 'primary'}
            className="font-medium"
          >
            {labels.filters}
          </Text>
          {hasActiveFilters && (
            <View className="w-2 h-2 rounded-full bg-primary-500" />
          )}
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={dark ? '#9ca3af' : '#6b7280'}
        />
      </Pressable>

      {/* Filter chips */}
      {expanded && (
        <View className="mt-2 gap-3">
          {/* Status chips */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Chip
              label={labels.all}
              active={isAll}
              onPress={() => handleStatusChange(undefined)}
              dark={dark}
            />
            <Chip
              label={labels.completed}
              active={isCompleted}
              onPress={() => handleStatusChange(['completed'])}
              dark={dark}
            />
            <Chip
              label={labels.canceled}
              active={isCanceled}
              onPress={() => handleStatusChange(['canceled'])}
              dark={dark}
            />
          </ScrollView>

          {/* Dropdowns row */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {serviceTypes && serviceTypes.length > 0 && (
              <DropdownChip
                label={labels.serviceType}
                options={serviceTypes}
                value={filters.serviceType}
                onChange={(v) => onFilterChange({ ...filters, serviceType: v })}
                dark={dark}
              />
            )}
            {paymentMethods && paymentMethods.length > 0 && (
              <DropdownChip
                label={labels.paymentMethod}
                options={paymentMethods}
                value={filters.paymentMethod}
                onChange={(v) => onFilterChange({ ...filters, paymentMethod: v })}
                dark={dark}
              />
            )}
          </ScrollView>

          {/* Clear filters */}
          {hasActiveFilters && (
            <Pressable onPress={clearFilters} className="self-start" accessibilityRole="button" accessibilityLabel={labels.clearFilters}>
              <Text variant="caption" color="accent" className="font-medium">
                {labels.clearFilters}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
