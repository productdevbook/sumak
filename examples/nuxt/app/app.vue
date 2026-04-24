<script setup lang="ts">
// Task list page. `useFetch` + Nuxt 4's data-fetching runs on the
// server for the initial render and on the client for subsequent
// navigations. The `refresh()` returned from the composable
// re-runs the query after a mutation.
const { data: tasks, refresh } = await useFetch("/api/tasks")

const newTitle = ref("")
async function addTask() {
  if (!newTitle.value.trim()) return
  await $fetch("/api/tasks", {
    method: "POST",
    body: { title: newTitle.value },
  })
  newTitle.value = ""
  await refresh()
}

async function toggle(id: number) {
  await $fetch(`/api/tasks/${id}`, { method: "PATCH" })
  await refresh()
}
</script>

<template>
  <main>
    <h1>Tasks</h1>
    <form @submit.prevent="addTask">
      <input v-model="newTitle" placeholder="New task…" />
      <button type="submit">Add</button>
    </form>
    <ul>
      <li v-for="t in tasks" :key="t.id">
        <button @click="toggle(t.id)">{{ t.doneAt ? "✓" : "○" }}</button>
        <span :style="{ textDecoration: t.doneAt ? 'line-through' : 'none' }">
          {{ t.title }}
        </span>
      </li>
    </ul>
  </main>
</template>
