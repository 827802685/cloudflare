<script setup lang="ts">
const props = defineProps<{ label: string; value: string; note?: string }>();
</script>

<template>
  <div class="card">
    <h3>{{ props.label }}</h3>
    <div class="tile-value">{{ props.value }}</div>
    <div class="tile-note" v-if="props.note">{{ props.note }}</div>
  </div>
</template>
